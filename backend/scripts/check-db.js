const sqlite3 = require('sqlite3');
const db = new sqlite3.Database('./data/fsu.db');
db.all("SELECT sql FROM sqlite_master WHERE type='table'", (err, rows) => {
  if (err) console.log(err);
  else rows.forEach(r => console.log(r.sql + '\n'));
  db.close();
});