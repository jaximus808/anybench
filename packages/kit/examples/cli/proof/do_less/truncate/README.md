# Do-less: truncated output

`driver.sh` here is the ripgrep driver rendered by `renderCliDoLessDriverScript` with
`keep_lines: 1`: one line differs, `subject() { subject_cmd | head -n 1; }`. It is faster because
it skips writing most of its output, and `same-matches` must fail it ("3 expected line(s)
missing and none extra (output truncated?)" on `literal-search`).
