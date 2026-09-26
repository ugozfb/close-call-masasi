// YALNIZ TEST: serve.mjs yalniz CLOSECALL_TEST=1 iken bu betigi sayfaya ekler.
// Sahte hakemin (tools/ui-test/mock-technocore.mjs, tohum 250) DID'i ve hizli okuma araligi.
// Arayuz bu ayari yalniz 127.0.0.1 / localhost uzerinde dikkate alir.
globalThis.__CLOSECALL_TEST__ = Object.freeze({
  refereeDid: "did:key:z6Mks57VNQDfpWZ4uTNqrS7RV2G71zSp6CrL2FgVjHqNZEib",
  pollMs: 1000,
});
