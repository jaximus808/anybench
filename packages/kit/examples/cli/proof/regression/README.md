# Planted regression: a fixed delay

Sets `PLANTED_DELAY_S=0.3`: the ripgrep driver sleeps 0.3 s before every search. Output is
unchanged (the gate passes) but wall time must score lower. Deterministic on purpose: one search
thread (`--threads 1`) is no slower on inputs this small, so it would not show that the kit can
see a slowdown at all (TDM-44).
