const { lib } = require('@alexneamtu/serverless-rspack');

module.exports = {
  entry: lib.entries,
  mode: 'production',
};
