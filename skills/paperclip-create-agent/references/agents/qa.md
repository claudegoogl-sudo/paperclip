# QA Agent Template (Pointer)

The canonical QA template now lives in the [`agents-md-kit`](https://github.com/claudegoogl-sudo/agents-md-kit) extension repo at [`templates/QA.md`](https://github.com/claudegoogl-sudo/agents-md-kit/blob/main/templates/QA.md). The recommended new-hire flow is the kit's one-shot installer:

```bash
curl -fsSL https://raw.githubusercontent.com/claudegoogl-sudo/agents-md-kit/main/scripts/install.sh \
  | bash -s -- --role QA --agent-name <Name> --company <Co> --manager-title <Title> --issue-prefix <PREFIX>
```

Then lint the generated `AGENTS.md` against the canonical template before submitting the hire request: `agents-md-lint --against-template <path-to-cloned-kit>/templates/QA.md AGENTS.md`.

Authoring rules and verbatim-region conventions: [`templates/_authoring-guide.md`](https://github.com/claudegoogl-sudo/agents-md-kit/blob/main/templates/_authoring-guide.md).

This file is kept as a back-compat pointer; do not edit role copy here.
