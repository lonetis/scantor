Typing tests: task files that must type-check against the installed `@scantor/connector`
(`/node_modules/@scantor/connector` of the base image), with `// @ts-expect-error` marking the
negative cases. Each directory has its own `package.json`, so the connector resolves like it does for
a task in `/task`. Run by `npm run test:typing` in the `test` stage of `connectors/js/Dockerfile`.
