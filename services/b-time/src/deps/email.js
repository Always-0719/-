import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// dev 无 SMTP 配置 → outbox jsonl 落盘便于断言；生产配 SMTP_HOST 走最小 SMTP 客户端
export function outboxAdapter(dir) {
  // .env 里的 OUTBOX_DIR=（空值）会绕过默认参数（默认参数只对 undefined 生效），故在此兜底
  dir = dir || process.env.OUTBOX_DIR || path.resolve(here, '../../outbox');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'emails.jsonl');
  return {
    kind: 'outbox',
    file,
    async send({ to, subject, text }) {
      await fs.promises.appendFile(file, JSON.stringify({ to, subject, text, at: new Date().toISOString() }) + '\n');
    },
  };
}

export function smtpAdapter({ host, port = 25, secure = false, user, pass, from, timeoutMs = 10000 }) {
  return {
    kind: 'smtp',
    send({ to, subject, text }) {
      return new Promise((resolve, reject) => {
        const sock = (secure ? tls.connect : net.connect)({ host, port: Number(port) });
        let buf = '';
        const fail = (e) => { sock.destroy(); reject(e); };
        const timer = setTimeout(() => fail(new Error('smtp timeout')), timeoutMs);
        sock.on('error', fail);
        const expect = (code, next) => {
          const onData = (d) => {
            buf += d.toString();
            const lines = buf.split('\r\n');
            buf = lines.pop();
            for (const line of lines) {
              if (!line) continue;
              if (Number(line.slice(0, 3)) !== code) return fail(new Error(`smtp expect ${code}: ${line}`));
              if (line[3] === '-') continue;
              sock.off('data', onData);
              next();
              return;
            }
          };
          sock.on('data', onData);
        };
        const write = (s) => sock.write(s + '\r\n');
        expect(220, () => {
          write(`EHLO b-time.local`);
          expect(250, () => {
            const auth = () => {
              write(`MAIL FROM:<${from}>`);
              expect(250, () => {
                write(`RCPT TO:<${to}>`);
                expect(250, () => {
                  write('DATA');
                  expect(354, () => {
                    write(`From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\n\r\n${text}\r\n.`);
                    expect(250, () => {
                      write('QUIT');
                      expect(221, () => {
                        clearTimeout(timer);
                        sock.end();
                        resolve();
                      });
                    });
                  });
                });
              });
            };
            if (user) {
              write(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString('base64')}`);
              expect(235, auth);
            } else auth();
          });
        });
      });
    },
  };
}

export function emailFromEnv(env = process.env) {
  if (env.SMTP_HOST) {
    return smtpAdapter({
      host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE === 'true',
      user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.SMTP_FROM || 'b-time@local',
    });
  }
  return outboxAdapter(env.OUTBOX_DIR);
}

// mock email-login 的 uid 形如 u-<email>；微信登录用户无邮箱 → 仅站内
export function emailOf(uid) {
  return uid.startsWith('u-') && uid.slice(2).includes('@') ? uid.slice(2) : null;
}