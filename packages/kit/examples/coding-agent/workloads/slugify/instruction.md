# Implement `slugify`

`src/slug.js` exports `slugify(title)`, which is a stub. Implement it:

- lower-case the title;
- strip accents (`é` becomes `e`, `ñ` becomes `n`);
- turn every run of characters that are not `a-z` or `0-9` into a single `-`;
- remove `-` from the start and the end;
- an empty result is `"untitled"`.

`slugify("  Hello, World!  ")` is `"hello-world"` and `slugify("Crème brûlée")` is `"creme-brulee"`.
Keep it dependency-free (plain Node, ES modules) and add tests under `test/`.
