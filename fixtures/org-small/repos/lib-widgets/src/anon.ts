// Entry point via exports "./anon".

// Expected: alive, no finding (anonymous default export, symbol name `default`; default-imported by @acme/consumer).
export default () => 'anon';
