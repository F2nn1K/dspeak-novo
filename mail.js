// Envio de e-mail do DSpeak (recuperação de senha).
// Configura no Render UMA destas opções:
//
// 1) Resend (mais simples):
//    RESEND_API_KEY = re_...
//    MAIL_FROM      = DSpeak <nao-responda@seudominio.com>
//
// 2) SMTP (Gmail, Outlook, etc.):
//    SMTP_HOST = smtp.gmail.com
//    SMTP_PORT = 587
//    SMTP_USER = seu@gmail.com
//    SMTP_PASS = senha de app (não a senha normal do Gmail)
//    MAIL_FROM = DSpeak <seu@gmail.com>   (opcional; usa SMTP_USER se faltar)

function isConfigured() {
  if (process.env.RESEND_API_KEY) return true;
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function fromAddress() {
  return process.env.MAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER || 'DSpeak <noreply@dspeak.app>';
}

async function sendViaResend({ to, subject, text, html }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: fromAddress(),
      to: [to],
      subject,
      text,
      html
    })
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Resend ${r.status}: ${body}`);
  }
}

async function sendViaSmtp({ to, subject, text, html }) {
  const nodemailer = require('nodemailer');
  const port = Number(process.env.SMTP_PORT || 587);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  await transporter.sendMail({
    from: fromAddress(),
    to,
    subject,
    text,
    html
  });
}

async function sendMail(opts) {
  if (process.env.RESEND_API_KEY) {
    await sendViaResend(opts);
    return;
  }
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    await sendViaSmtp(opts);
    return;
  }
  const err = new Error('E-mail não configurado no servidor');
  err.code = 'MAIL_NOT_CONFIGURED';
  throw err;
}

module.exports = { isConfigured, sendMail };
