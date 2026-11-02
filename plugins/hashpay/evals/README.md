# hashpay-setup evals

`claude plugin eval` runs are network-confined by design, so this suite holds the checks that don't
need the HashPay API:

| Case | What it guards |
|------|----------------|
| `should-not-fire` | Another provider's payments question doesn't pull in this skill |

```bash
claude plugin eval plugins/hashpay
```

The behaviour that matters most — a no-code setup from zero, a mistyped address never "corrected",
never inventing an address, the secret key never printed — is checked against a real (throwaway,
local) HashPay API by an outcome-based harness that runs headless Claude Code with this plugin and
then reads back what was actually created. It lives with the API, since it needs to start one.
