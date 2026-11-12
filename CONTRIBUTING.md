# Contributing

Read [AGENTS.md](AGENTS.md) first.

The repository uses `main`/`develop` Gitflow:

- `main`: releases; tags use the `v` prefix.
- `develop`: integration and default branch.
- `feature/<issue>-<name>` and `bugfix/<issue>-<name>`: work branches from
  `develop`.

Every change starts from an Issue and reaches `develop` through an
Issue-linked pull request merged with a merge commit; source branches are
kept. Commit and PR titles use English `type(scope): description`.

## Local setup

With [`governed-git-flow`](https://github.com/NickF93/gh-git-skill-flow)
installed, run from this checkout:

```bash
governed-git-flow --repo "$PWD" inspect --online
governed-git-flow --repo "$PWD" config gitflow
```

## License

Contributions are licensed under the [MIT License](LICENSE).
