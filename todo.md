# TODO

- Client e2e tests already exist in `client/e2e/*.spec.ts` and import `@playwright/test`, but the Vite+ migration does not wire them in yet.
- Do next:
  - install `@playwright/test` in `client/`
  - add `playwright.config.ts`
  - add package scripts for e2e runs
  - decide whether e2e should be part of normal CI/static validation or remain separate from `vp check`
  - remove the temporary `e2e/**` exclusion from the Vite+ lint/type-check setup once the e2e toolchain is properly configured
