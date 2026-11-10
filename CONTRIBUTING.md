# Contributing

Contributions of any kind are welcome! If you've found a bug or have a feature request, please open an issue in this repository.

To make changes yourself, follow these steps:

1. [Fork](https://docs.github.com/en/get-started/quickstart/fork-a-repo) this repository and [clone](https://docs.github.com/en/repositories/creating-and-managing-repositories/cloning-a-repository) it locally.
2. Install Node.js 22.13+ and run `npm install` from the repository root.
3. Build the plugin with `npm run build -w @stripe/radar-better-auth`.
4. Make your changes. See the [README](README.md#run-the-example) to run the example locally.
5. Run `npm run test:package`, `npm test`, and `npm run typecheck`. Check formatting with `npm run format:check`; use `npm run format` to apply formatting fixes.
6. Submit a [pull request](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/creating-a-pull-request-from-a-fork) describing your changes and how you tested them.

The default tests use local mocks and do not require Stripe credentials. See the [README](README.md#contributing) for optional Stripe sandbox integration tests.

## Contributor License Agreement ([CLA](https://en.wikipedia.org/wiki/Contributor_License_Agreement))

Once you have submitted a pull request, sign the CLA by clicking on the badge in the comment from [@CLAassistant](https://github.com/CLAassistant).

Thanks for contributing to Stripe!
