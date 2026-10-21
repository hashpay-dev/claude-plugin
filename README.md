# HashPay for Claude Code

Let your coding agent set up [HashPay](https://hashpay.dev) end to end. HashPay accepts USDC and USDT
on eight chains, and every payment goes **straight to your own wallet** — HashPay never holds funds or
keys.

You sign up and create a secret key. The agent does the rest: your receiving wallets (after reading
each address back to you), the webhook endpoint **and** the handler code that receives it, products
and prices, the checkout embed on your site, and a test payment that proves the whole chain works.

## Install

```
/plugin marketplace add hashpay-dev/claude-plugin
/plugin install hashpay@hashpay
```

## Use

1. Sign up at [app.hashpay.dev](https://app.hashpay.dev) and verify your email.
2. **Integration** → **Create** under *Secret key*. Put it in your shell, not in the chat:
   `export HASHPAY_SECRET_KEY=sk_live_…`
3. Ask Claude: *"Set up HashPay for this project. My secret key is in `$HASHPAY_SECRET_KEY`."*

Have your wallet addresses ready — the agent will ask for them and never makes one up. Every wallet,
webhook and key change emails your sign-in address, naming the key that made it.

## Not using Claude Code?

The same instructions are served at [hashpay.dev/agent/hashpay-setup/SKILL.md](https://hashpay.dev/agent/hashpay-setup/SKILL.md)
(index: [hashpay.dev/llms.txt](https://hashpay.dev/llms.txt)), as a
[.zip](https://hashpay.dev/agent/hashpay-setup.zip) for uploading as a skill, and the API contract at
[api.hashpay.dev/openapi.json](https://api.hashpay.dev/openapi.json).

## What's inside

| Path | |
|------|-|
| `plugins/hashpay/skills/hashpay-setup/SKILL.md` | The setup walkthrough the agent follows |
| `…/references/webhook-handler.md` | Event catalog, payload, signature scheme, handler rules |
| `…/assets/handler-express.js`, `handler-fastapi.py` | Verified webhook receivers to start from |

MIT licensed. Docs: [hashpay.dev/docs](https://hashpay.dev/docs).
