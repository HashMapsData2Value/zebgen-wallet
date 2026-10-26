# LeakSwap contract artifacts

These reviewed contract artifacts are bundled locally because the published
`leakswap-utils` npm package contains utilities, not compiled contracts. Zebgen
does not need a sibling protocol checkout or Git submodule to build.

Source: https://github.com/HashMapsData2Value/leakswap-protocol/tree/6e640568c46e2e42b85ce0722a6525b941a12d51/algorand/projects/algorand/smart_contracts/artifacts/leak_swap

SHA-256:

```text
6907562f305adab3a097ff8668da0ec4ac4815b60a68f0771a843dcf9a5c03f3  LeakSwap.arc56.json
65c6a66abdaffedc4c9ac0e084ad9e57574a13ebe9a5bb013913ebe3b058b124  FeeSponsorLSig.teal
```

Update these files only after reviewing the corresponding contract revision
and validating wallet deployment, funding, and settlement checks. Updating the
npm utilities does not automatically change the accepted contract bytecode.