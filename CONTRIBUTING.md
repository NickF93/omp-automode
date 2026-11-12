# Contributing

Read [AGENTS.md](AGENTS.md) first.

## Branch model

The repository uses `main`/`develop` Gitflow:

- `main`: releases only; tags use the `v` prefix (`v1.2.3`).
- `develop`: integration and default branch.
- `feature/<issue>-<name>` and `bugfix/<issue>-<name>`: work branches created
  from `develop`.

Never commit or push directly to `main` or `develop`.

## Local setup

Only Git is required; the [GitHub CLI](https://cli.github.com/) is optional for
Issues and pull requests. After cloning, record the branch conventions in the
local Git configuration (compatible with `git flow` tooling if you use it):

```bash
git config gitflow.branch.master main
git config gitflow.branch.develop develop
git config gitflow.prefix.feature feature/
git config gitflow.prefix.bugfix bugfix/
git config gitflow.prefix.release release/
git config gitflow.prefix.hotfix hotfix/
git config gitflow.prefix.versiontag v
```

## Making a change

1. Open an Issue describing the problem, or pick an existing one.
2. Create a branch from the latest `develop`:

   ```bash
   git switch develop
   git pull --ff-only
   git switch -c feature/<issue>-<short-name>
   ```

3. Commit with English conventional messages, `type(scope): description`
   (for example `fix(review): handle empty verdict`). Stage exact files and
   review the staged diff before committing.
4. Push without force and open a pull request to `develop` that links the
   Issue (`Closes #<issue>`).
5. The maintainer merges with a merge commit; source branches are kept.

## AI-assisted contributions

Contributions written with AI assistance are welcome. The person who submits
them is the author and is fully responsible for what is published: they must
understand, review and test it, and be able to explain it. Commits and pull
requests carry that person's identity; do not add AI, agent or tool authorship
credit.

## License

Contributions are licensed under the [MIT License](LICENSE).
