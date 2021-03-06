'use strict';

const AbstractConnectionManager = require('../abstract/connection-manager');
const ResourceLock = require('./resource-lock');
const Promise = require('../../promise');
const logger = require('../../utils/logger');
const sequelizeErrors = require('../../errors');
const DataTypes = require('../../data-types').mssql;
const parserStore = require('../parserStore')('mssql');
const debug = logger.getLogger().debugContext('connection:mssql');
const debugTedious = logger.getLogger().debugContext('connection:mssql:tedious');

class ConnectionManager extends AbstractConnectionManager {
  constructor(dialect, sequelize) {
    super(dialect, sequelize);
    this.sequelize.config.port = this.sequelize.config.port || 1433;
    this.lib = this._loadDialectModule('tedious');
    this.refreshTypeParser(DataTypes);
  }

  _refreshTypeParser(dataType) {
    parserStore.refresh(dataType);
  }

  _clearTypeParser() {
    parserStore.clear();
  }

  connect(config) {
    const connectionConfig = {
      userName: config.username,
      password: config.password,
      server: config.host,
      options: {
        port: config.port,
        database: config.database,
        encrypt: false
      }
    };

    if (config.dialectOptions) {
      // only set port if no instance name was provided
      if (config.dialectOptions.instanceName) {
        delete connectionConfig.options.port;
      }

      // The 'tedious' driver needs domain property to be in the main Connection config object
      if (config.dialectOptions.domain) {
        connectionConfig.domain = config.dialectOptions.domain;
      }

      for (const key of Object.keys(config.dialectOptions)) {
        connectionConfig.options[key] = config.dialectOptions[key];
      }
    }

    return new Promise((resolve, reject) => {
      const connection = new this.lib.Connection(connectionConfig);
      connection.lib = this.lib;
      const resourceLock = new ResourceLock(connection);

      const connectHandler = error => {
        connection.removeListener('end', endHandler);
        connection.removeListener('error', errorHandler);

        if (error) return reject(error);

        debug('connection acquired');
        resolve(resourceLock);
      };

      const endHandler = () => {
        connection.removeListener('connect', connectHandler);
        connection.removeListener('error', errorHandler);
        reject(new Error('Connection was closed by remote server'));
      };

      const errorHandler = error => {
        connection.removeListener('connect', connectHandler);
        connection.removeListener('end', endHandler);
        reject(error);
      };

      connection.once('error', errorHandler);
      connection.once('end', endHandler);
      connection.once('connect', connectHandler);

      if (config.dialectOptions && config.dialectOptions.debug) {
        connection.on('debug', debugTedious);
      }
    }).tap(resourceLock => {
      const connection = resourceLock.unwrap();
      connection.on('error', error => {
        switch (error.code) {
          case 'ESOCKET':
          case 'ECONNRESET':
            this.pool.destroy(resourceLock);
        }
      });
    }).catch(error => {
      if (!error.code) {
        throw new sequelizeErrors.ConnectionError(error);
      }

      switch (error.code) {
        case 'ESOCKET':
          if (error.message.includes('connect EHOSTUNREACH')) {
            throw new sequelizeErrors.HostNotReachableError(error);
          }
          if (error.message.includes('connect ENETUNREACH')) {
            throw new sequelizeErrors.HostNotReachableError(error);
          }
          if (error.message.includes('connect EADDRNOTAVAIL')) {
            throw new sequelizeErrors.HostNotReachableError(error);
          }
          if (error.message.includes('getaddrinfo ENOTFOUND')) {
            throw new sequelizeErrors.HostNotFoundError(error);
          }
          if (error.message.includes('connect ECONNREFUSED')) {
            throw new sequelizeErrors.ConnectionRefusedError(error);
          }
          throw new sequelizeErrors.ConnectionError(error);
        case 'ER_ACCESS_DENIED_ERROR':
        case 'ELOGIN':
          throw new sequelizeErrors.AccessDeniedError(error);
        case 'EINVAL':
          throw new sequelizeErrors.InvalidConnectionError(error);
        default:
          throw new sequelizeErrors.ConnectionError(error);
      }
    });
  }

  disconnect(connectionLock) {
    /**
     * Abstract connection may try to disconnect raw connection used for fetching version
     */
    const connection = connectionLock.unwrap
      ? connectionLock.unwrap()
      : connectionLock;

    // Don't disconnect a connection that is already disconnected
    if (connection.closed) {
      return Promise.resolve();
    }

    return new Promise(resolve => {
      connection.on('end', resolve);
      connection.close();
      debug('connection closed');
    });
  }

  validate(connectionLock) {
    /**
     * Abstract connection may try to validate raw connection used for fetching version
     */
    const connection = connectionLock.unwrap
      ? connectionLock.unwrap()
      : connectionLock;

    return connection && connection.loggedIn;
  }
}

module.exports = ConnectionManager;
module.exports.ConnectionManager = ConnectionManager;
module.exports.default = ConnectionManager;
