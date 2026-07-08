#!/usr/bin/env node
// CLI for managing users out-of-band. No HTTP route can ever create/promote
// an admin -- this script (run on the server box) is the only path.
const readline = require('readline');
const bcrypt = require('bcrypt');
const { db } = require('../db');
const validate = require('../lib/validate');

const BCRYPT_COST = 12;

// Control character codes we care about while reading a masked password.
const CODE_NEWLINE = 10; // \n
const CODE_RETURN = 13; // \r
const CODE_EOF = 4; // Ctrl-D
const CODE_INTERRUPT = 3; // Ctrl-C
const CODE_BACKSPACE = 127; // DEL
const CODE_BACKSPACE_ALT = 8; // \b

function promptVisible(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);

    if (!stdin.isTTY) {
      // Fallback: no TTY to mask, just read a line plainly.
      const rl = readline.createInterface({ input: stdin, output: process.stdout });
      rl.question('', (answer) => {
        rl.close();
        resolve(answer);
      });
      return;
    }

    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);

    let input = '';
    const onData = (char) => {
      const code = char.charCodeAt(0);
      if (code === CODE_NEWLINE || code === CODE_RETURN || code === CODE_EOF) {
        stdin.removeListener('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        process.stdout.write('\n');
        resolve(input);
      } else if (code === CODE_INTERRUPT) {
        process.stdout.write('\n');
        process.exit(1);
      } else if (code === CODE_BACKSPACE || code === CODE_BACKSPACE_ALT) {
        input = input.slice(0, -1);
      } else {
        input += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function cmdCreate() {
  let email;
  let username;
  let password;

  if (process.stdin.isTTY) {
    email = await promptVisible('Email: ');
    username = await promptVisible('Username: ');
    password = await promptHidden('Password: ');
  } else {
    email = process.env.ADMIN_EMAIL;
    username = process.env.ADMIN_USERNAME;
    password = process.env.ADMIN_PASSWORD;
    if (!email || !username || !password) {
      console.error(
        'Non-interactive shell detected: set ADMIN_EMAIL, ADMIN_USERNAME, and ' +
          'ADMIN_PASSWORD env vars to create an admin without prompts (useful for scripting).'
      );
      process.exitCode = 1;
      return;
    }
  }

  const emailResult = validate.email(email);
  if (!emailResult.ok) {
    console.error(`Invalid email: ${emailResult.error}`);
    process.exitCode = 1;
    return;
  }

  const usernameResult = validate.username(username);
  if (!usernameResult.ok) {
    console.error(`Invalid username: ${usernameResult.error}`);
    process.exitCode = 1;
    return;
  }

  const passwordResult = validate.password(password);
  if (!passwordResult.ok) {
    console.error(`Invalid password: ${passwordResult.error}`);
    process.exitCode = 1;
    return;
  }

  const existing = db
    .prepare('SELECT id FROM users WHERE email = ? OR username = ?')
    .get(emailResult.value, usernameResult.value);
  if (existing) {
    console.error('A user with that email or username already exists.');
    process.exitCode = 1;
    return;
  }

  const passwordHash = bcrypt.hashSync(passwordResult.value, BCRYPT_COST);
  db.prepare(
    `INSERT INTO users (email, username, password_hash, role, status)
     VALUES (?, ?, ?, 'admin', 'approved')`
  ).run(emailResult.value, usernameResult.value, passwordHash);

  console.log(`Admin '${usernameResult.value}' created and approved.`);
}

function cmdPromote(username) {
  if (!username) {
    console.error('Usage: node scripts/admin.js promote <username>');
    process.exitCode = 1;
    return;
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    console.error(`No user named '${username}'.`);
    process.exitCode = 1;
    return;
  }
  if (user.role === 'admin') {
    console.log(`'${username}' is already an admin.`);
    return;
  }
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  console.log(`'${username}' promoted to admin.`);
}

function cmdDemote(username) {
  if (!username) {
    console.error('Usage: node scripts/admin.js demote <username>');
    process.exitCode = 1;
    return;
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    console.error(`No user named '${username}'.`);
    process.exitCode = 1;
    return;
  }
  if (user.role !== 'admin') {
    console.log(`'${username}' is not an admin.`);
    return;
  }
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get();
  if (n <= 1) {
    console.error('Refusing to demote the last admin.');
    process.exitCode = 1;
    return;
  }
  db.prepare("UPDATE users SET role = 'brother' WHERE id = ?").run(user.id);
  console.log(`'${username}' demoted to brother.`);
}

function cmdList() {
  const users = db
    .prepare('SELECT id, email, username, role, status, created_at FROM users ORDER BY id')
    .all();
  if (users.length === 0) {
    console.log('No users yet.');
    return;
  }
  console.log('id\tusername\temail\trole\tstatus\tcreated_at');
  for (const u of users) {
    console.log(`${u.id}\t${u.username}\t${u.email}\t${u.role}\t${u.status}\t${u.created_at}`);
  }
}

async function main() {
  const [, , cmd, arg] = process.argv;
  switch (cmd) {
    case 'create':
      await cmdCreate();
      break;
    case 'promote':
      cmdPromote(arg);
      break;
    case 'demote':
      cmdDemote(arg);
      break;
    case 'list':
      cmdList();
      break;
    default:
      console.log('Usage: node scripts/admin.js <create|promote|demote|list> [username]');
      process.exitCode = cmd ? 1 : 0;
  }
}

main();
