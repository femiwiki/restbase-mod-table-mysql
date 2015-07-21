"use strict";

var dbu = require('./dbutils');
var P = require('bluebird');
var TimeUuid = require("cassandra-uuid").TimeUuid;
var SchemaMigrator = require('./SchemaMigrator');
var Wrapper = require('./clientWrapper');

function DB(options) {
    this.conf = options.conf;
    this.log = options.log;
    // SQLite client
    this.client = new Wrapper(options);
    this.schemaCache = {};
}

// Info table schema
DB.prototype.infoSchema = dbu.validateAndNormalizeSchema({
    table: 'meta',
    attributes: {
        key: 'string',
        value: 'json',
        tid: 'timeuuid'
    },
    index: [
        {attribute: 'key', type: 'hash'},
        {attribute: 'tid', type: 'range', order: 'desc'}
    ]
});

DB.prototype.infoSchemaInfo = dbu.makeSchemaInfo(DB.prototype.infoSchema, true);

DB.prototype.getTableSchema = function(domain, table) {
    var keyspace = dbu.keyspaceName(domain, table);
    return this._get(keyspace, {}, 'meta', this.infoSchemaInfo)
    .then(function(res) {
        if (res && res.items.length) {
            return {
                status: 200,
                tid: res.items[0].tid,
                schema: JSON.parse(res.items[0].value)
            };
        } else {
            throw new dbu.HTTPError({
                status: 404,
                body: {
                    type: 'notfound',
                    title: 'the requested table schema was not found'
                }
            });
        }
    });
};

DB.prototype._getSchema = function(keyspace) {
    return this._get(keyspace, {}, 'meta', this.infoSchemaInfo)
    .then(function(res) {
        if (res && res.items.length) {
            var schema = JSON.parse(res.items[0].value);
            return dbu.makeSchemaInfo(schema);
        } else {
            return null;
        }
    });
};

DB.prototype.createTable = function(domain, req) {
    var self = this;
    if (!req.table) {
        throw new Error('Table name required.');
    }

    var keyspace = dbu.keyspaceName(domain, req.table);

    return this._getSchema(keyspace)
    .then(function(currentSchema) {
        // Validate and normalize the schema
        var schema = dbu.validateAndNormalizeSchema(req);
        var schemaInfo = dbu.makeSchemaInfo(schema);
        var createOperation;
        if (currentSchema) {
            if (currentSchema.hash !== schemaInfo.hash) {
                var migrator;
                try {
                    migrator = new SchemaMigrator(self, req, keyspace, currentSchema, schemaInfo);
                }
                catch (error) {
                    throw new dbu.HTTPError({
                        status: 400,
                        body: {
                            type: 'bad_request',
                            title: 'The table already exists, and its schema cannot be upgraded to the requested schema (' + error + ').',
                            keyspace: keyspace,
                            schema: schemaInfo
                        }
                    });
                }
                createOperation = migrator.migrate()
                .catch(function(error) {
                    self.log('error/cassandra/table_update', error);
                    throw error;
                });
            } else {
                return {status: 201};
            }
        } else {
            createOperation = self._createTable(keyspace, schemaInfo);
        }
        return createOperation.then(function() {
            self.schemaCache[keyspace] = schemaInfo;
            return self._put(keyspace, {
                attributes: {
                    key: 'schema',
                    value: JSON.stringify(schema)
                }
            }, 'meta');
        });
    });
};

DB.prototype._createTable = function(keyspace, schema) {
    var self = this;

    if (!schema.attributes) {
        throw new Error('No attribute definitions for table ' + keyspace);
    }

    return self.client.run([
        {sql: dbu.buildTableSql(schema, keyspace, 'data')},
        {sql: dbu.buildTableSql(self.infoSchemaInfo, keyspace, 'meta')},
        {sql: dbu.buildStaticsTableSql(schema, keyspace)},
        {sql: dbu.buildIndexViewSql(schema, keyspace)}
    ]);
};

DB.prototype.dropTable = function(domain, table) {
    var self = this;
    var keyspace = dbu.keyspaceName(domain, table);
    var deleteRequest = function(schema) {
        var queries = [
            {sql: 'drop view ' + keyspace + '_indexView'},
            {sql: 'drop table ' + keyspace + '_meta'},
            {sql: 'drop table ' + keyspace + '_data'}
        ];
        if (dbu.staticTableExist(schema)) {
            queries.push({sql: 'drop table ' + keyspace + '_static'});
        }
        return self.client.run(queries);
    };

    if (!self.schemaCache[keyspace]) {
        return this._getSchema(keyspace)
        .then(function(schema) {
            return deleteRequest(schema);
        });
    } else {
        var schema = self.schemaCache[keyspace];
        delete self.schemaCache[keyspace];
        return deleteRequest(schema);
    }
};

DB.prototype.get = function(domain, req) {
    var self = this;

    var keyspace = dbu.keyspaceName(domain, req.table);

    if (!self.schemaCache[keyspace]) {
        return this._getSchema(keyspace)
        .then(function(schema) {
            self.schemaCache[keyspace] = schema;
            return self._get(keyspace, req, 'data', schema);
        });
    } else {
        return self._get(keyspace, req, 'data', self.schemaCache[keyspace]);
    }
};

DB.prototype._get = function(keyspace, req, table, schema, includePreparedForDelete) {
    var self = this;
    if (!table) {
        table = 'data';
    }

    if (!schema) {
        throw new Error('restbase-sqlite3: No schema for ' + keyspace + '_' + table);
    }
    var buildResult = dbu.buildGetQuery(keyspace, req, table, schema, includePreparedForDelete);
    return self.client.all(buildResult.sql, buildResult.params)
    .then(function(result) {
        if (!result) {
            return {
                count: 0,
                items: []
            };
        }
        var rows = [];
        var convertRow = function(row) {
            delete row._exist_until;
            Object.keys(row).forEach(function(key) {
                row[key] = schema.converters[schema.attributes[key]].read(row[key]);
            });
            return row;
        };
        if (result instanceof Array) {
            rows = result.map(convertRow) || [];
        } else {
            rows.push(convertRow(result));
        }
        result = {
            count: rows.length,
            items: rows
        };
        if (req.next || req.limit) {
            result.next = (req.next || 0) + rows.length;
        }
        return result;
    })
    .catch(function(err) {
        if (err instanceof Object && err.cause && err.cause.code === 'SQLITE_ERROR') {
            return {
                count: 0,
                items: []
            };
        } else {
            throw err;
        }
    });
};

DB.prototype.put = function(domain, req) {
    var self = this;
    var keyspace = dbu.keyspaceName(domain, req.table);
    if (!self.schemaCache[keyspace]) {
        return self._getSchema(keyspace)
        .then(function(schema) {
            self.schemaCache[keyspace] = schema;
            return self._put(keyspace, req);
        });
    } else {
        return self._put(keyspace, req);
    }
};

DB.prototype._put = function(keyspace, req, table) {
    var self = this;
    if (!table) {
        table = 'data';
    }

    var schema;
    if (table === 'meta') {
        schema = this.infoSchemaInfo;
    } else if (table === "data") {
        schema = this.schemaCache[keyspace];
    }

    if (!schema) {
        throw new Error('Table not found!');
    }

    if (!req.attributes[schema.tid]) {
        req.attributes[schema.tid] = TimeUuid.now().toString();
    }

    req.timestamp = TimeUuid.fromString(req.attributes[schema.tid].toString()).getDate();
    var query = dbu.buildPutQuery(req, keyspace, table, schema);
    var queries = [ query.data ];
    if (query.static) {
        queries.push(query.static);
    }
    return self.client.run(queries)
    .then(function() {
        if (table === 'data') {
            self._revisionPolicyUpdate(keyspace, req, schema);
        }
    })
    .then(function() {
        return {status: 201};
    });
};

DB.prototype._revisionPolicyUpdate = function(keyspace, query, schema) {
    var self = this;
    // Step 1: set _exists_until for required rows
    if (schema.revisionRetentionPolicy.type === 'latest') {
        var dataQuery = {
            table: query.table,
            attributes: {}
        };
        var expireTime = new Date().getTime() + schema.revisionRetentionPolicy.grace_ttl * 1000;
        schema.iKeys.forEach(function(att) {
            if (att !== schema.tid) {
                dataQuery.attributes[att] = query.attributes[att];
            }
        });
        dataQuery.order = {};
        dataQuery.order[schema.tid] = 'asc';
        return self._get(keyspace, dataQuery, 'data', schema, false)
        .then(function(result) {
            if (result.count > schema.revisionRetentionPolicy.count) {
                var extraItems = result.items.slice(0, result.count - schema.revisionRetentionPolicy.count);
                return P.all(extraItems.map(function(item) {
                    var updateQuery = {
                        table: query.table,
                        attributes: item
                    };
                    updateQuery.attributes._exist_until = expireTime;
                    return dbu.buildPutQuery(updateQuery, keyspace, 'data', schema).data;
                }))
                .then(function(queries) {
                    queries.push(dbu.buildDeleteExpiredQuery(schema, keyspace));
                    return self.client.run(queries);
                });
            }
        });
    }
};

module.exports = DB;