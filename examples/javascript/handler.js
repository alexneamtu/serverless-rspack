const { greeting } = require('./greeting');

exports.hello = async (event) => ({ message: greeting(event.name) });
