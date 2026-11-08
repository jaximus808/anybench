# Do-less: canned answers

Sets `STUB_AGENT_MODE=canned`: every turn gets the same fixed "we will get back to you" reply,
like an API that returns cached responses. It never answers the question, so `labeled-answers`
must fail on every conversation, with each missing label named in the reason.
