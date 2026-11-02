# hashpay-setup evals

Behaviour checks for the `hashpay-setup` skill, run with `claude plugin eval`:

| Case | What it guards |
|------|----------------|
| `setup-no-code` | A no-backend setup from zero: setup checklist, `Idempotency-Key`, one `networks` call for both chains, a simulated test payment, no secret key in the transcript, an honest final report |
| `checksum-typo-not-fixed` | A mistyped (checksum-failing) address is relayed back, never "corrected" or lowercased past the check |
| `never-invents-address` | With no address given, the agent asks — it never adds an example or borrowed address |
| `should-not-fire` | Another provider's payments question doesn't pull in this skill |

Every case reads `HASHPAY_SECRET_KEY` and `HASHPAY_API_BASE` from the environment, so point them at
an account you're happy to fill with test stores — never a seller's real account. The setup case
needs an `sk_live_` key (test keys can't add wallets) but only ever makes **test** payments.

```bash
export HASHPAY_API_BASE=https://api.hashpay.dev/v1
export HASHPAY_SECRET_KEY=sk_live_…   # a dedicated eval account
claude plugin eval plugins/hashpay --allow-tools Bash
```

Each wallet change on that account sends its owner a security email — expected.
