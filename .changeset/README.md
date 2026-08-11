# Changesets

Add a changeset for every user-visible change:

```sh
pnpm changeset
```

The release workflow maintains a version PR. Merging that PR publishes the
package to npm through Trusted Publishing (OIDC), without an npm token.
