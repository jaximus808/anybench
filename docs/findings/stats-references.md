# Stats reference values (TDM-175 [16.4])

The decision rule's numerics (`packages/bench/src/stats.ts`, `decide.ts`) are checked against
scipy 1.18.1 and statsmodels 0.15.0. R is not installed on the build Mac, so R's
`wilcox.test(conf.int = TRUE)` Hodges–Lehmann algorithm (`qwilcox(α/2)`, then
`diffs[qu]`, `diffs[mn − qu + 1]`, attained α = `2·pwilcox(qu − 1)`) was re-implemented in
Python over the exact U distribution, enumerated by brute force. The values are hard-coded in
`packages/bench/test/stats-tdm175.test.ts`.

Command (from an empty scratch directory):

```
uv run --no-project --with scipy --with statsmodels python refs.py
```

## refs.py

```python
import numpy as np
from scipy import stats
from statsmodels.stats.proportion import proportion_confint, confint_proportions_2indep
from statsmodels.stats.multitest import multipletests

print("norm.ppf(0.975)", repr(stats.norm.ppf(0.975)))
print("norm.ppf(0.001)", repr(stats.norm.ppf(0.001)))
print("norm.ppf(1e-10)", repr(stats.norm.ppf(1e-10)))
print("norm.cdf(1.2345)", repr(stats.norm.cdf(1.2345)))
print("norm.cdf(-3.1)", repr(stats.norm.cdf(-3.1)))
print("norm.cdf(8.5) sf", repr(stats.norm.sf(8.5)))
for x,n in [(11,15),(9,15),(0,10),(10,10),(3,7)]:
    print("wilson", x, n, proportion_confint(x, n, alpha=0.05, method="wilson"))
for a in [(11,15,9,15),(15,15,5,15),(3,7,6,8)]:
    print("newcombe", a, confint_proportions_2indep(a[0],a[1],a[2],a[3], method="newcomb", compare="diff", alpha=0.05))
# MW exact no ties
x=[1.83,0.50,1.62,2.48,1.68,1.88,1.55,3.06,1.30]; y=[0.878,0.647,0.598,2.05,1.06,1.29,1.06,3.14,1.29]
print("mw exact", stats.mannwhitneyu(x,y,method="exact"))
x2=[10.1,10.4,9.8,10.0,10.3]; y2=[12.2,11.9,12.5,12.0,12.4]
print("mw exact sep 5v5", stats.mannwhitneyu(x2,y2,method="exact"))
x3=[1,2,2,3,3,3,5]; y3=[2,3,4,4,5,6]
print("mw perm ties", stats.mannwhitneyu(x3,y3,method=stats.PermutationMethod(n_resamples=np.inf)))
print("mw asymp ties", stats.mannwhitneyu(x3,y3,method="asymptotic"))
rng=np.random.default_rng(1)
xa=np.round(rng.normal(0,1,40),2); ya=np.round(rng.normal(0.5,1,35),2)
print("xa", list(xa)); print("ya", list(ya))
print("mw asymp big", stats.mannwhitneyu(xa,ya,method="asymptotic"))
print("holm", multipletests([0.01,0.04,0.03,0.005],method="holm")[1])
# order stat median CI coverage
for n in [5,6,10,20]:
    print("binom", n, [1-2*stats.binom.cdf(k-1,n,0.5) for k in range(1,4)])
# HL CI via R algorithm using scipy's exact MWU null distribution
from scipy.stats._mannwhitneyu import _mwu_state
def hl_ci(x,y,level=0.95):
    m,n=len(x),len(y)
    d=np.sort(np.subtract.outer(np.array(x),np.array(y)).ravel())
    dist=_mwu_state if False else None
    # exact cdf of U by enumeration via scipy
    from itertools import combinations
    N=m+n; ranks=np.arange(1,N+1)
    from collections import Counter
    c=Counter()
    for comb in combinations(range(N),m):
        U=sum(ranks[list(comb)])-m*(m+1)/2; c[U]+=1
    tot=sum(c.values()); cdf={}; acc=0
    for u in range(m*n+1): acc+=c.get(u,0); cdf[u]=acc/tot
    alpha=1-level
    qu=min(u for u in range(m*n+1) if cdf[u]>=alpha/2)
    if qu==0: qu=1
    ach=1-2*cdf[qu-1] if qu-1>=0 else 1
    return float(np.median(d)), float(d[qu-1]), float(d[m*n-qu]), ach
print("hl", hl_ci(x[:7],y[:6]))
print("hl 3v3", hl_ci([1.0,2.0,3.0],[2.5,3.5,4.5]))
print("hl 5v5", hl_ci(x2,y2))
```

## Output

```
norm.ppf(0.975) np.float64(1.959963984540054)
norm.ppf(0.001) np.float64(-3.090232306167813)
norm.ppf(1e-10) np.float64(-6.361340902404056)
norm.cdf(1.2345) np.float64(0.8914916766373298)
norm.cdf(-3.1) np.float64(0.0009676032132183562)
norm.cdf(8.5) sf np.float64(9.479534822203251e-18)
wilson 11 15 (0.48049565944019423, 0.8910254667430763)
wilson 9 15 (0.35746830120624595, 0.8017550385865843)
wilson 0 10 (0.0, 0.27753279986288926)
wilson 10 10 (0.7224672001371106, 1.0)
wilson 3 7 (0.15821985525146964, 0.7495416354723428)
newcombe (11, 15, 9, 15) (np.float64(-0.19013534356563233), np.float64(0.42262286625683954))
newcombe (15, 15, 5, 15) (np.float64(0.344433498191572), np.float64(0.8482367556028528))
newcombe (3, 7, 6, 8) (np.float64(-0.6454033307481577), np.float64(0.14666875403733665))
mw exact MannwhitneyuResult(statistic=np.float64(58.0), pvalue=np.float64(0.13591114767585355))
mw exact sep 5v5 MannwhitneyuResult(statistic=np.float64(0.0), pvalue=np.float64(0.007936507936507936))
mw perm ties MannwhitneyuResult(statistic=np.float64(10.0), pvalue=np.float64(0.13286713286713286))
mw asymp ties MannwhitneyuResult(statistic=np.float64(10.0), pvalue=np.float64(0.125006218529338))
mw asymp big MannwhitneyuResult(statistic=np.float64(534.5), pvalue=np.float64(0.07971264883121788))
holm [0.03 0.06 0.06 0.02]
binom 5 [np.float64(0.9375), np.float64(0.625), np.float64(0.0)]
binom 6 [np.float64(0.96875), np.float64(0.78125), np.float64(0.3125)]
binom 10 [np.float64(0.998046875), np.float64(0.978515625), np.float64(0.890625)]
binom 20 [np.float64(0.9999980926513672), np.float64(0.9999599456787109), np.float64(0.9995975494384766)]
hl (0.7070000000000001, -0.3699999999999999, 1.2320000000000002, 0.965034965034965)
hl 3v3 (-1.5, -3.5, 0.5, 0.9)
hl 5v5 (-2.0999999999999996, -2.5, -1.5999999999999996, 0.9682539682539683)
```

(`mw exact` on the first x/y pair is ignored: y has ties, which scipy's exact method doesn't
handle. The tests use x[:7] vs y[:6], which has none.)

## Follow-ups (refs2.py, refs3.py)

```python
import numpy as np
from scipy import stats
x=[1.83,0.50,1.62,2.48,1.68,1.88,1.55]; y=[0.878,0.647,0.598,2.05,1.06,1.29]
print(stats.mannwhitneyu(x,y,method="exact"))
# censored ties at cap 
a=[100,120,3600,3600,110]; b=[3600,3600,3600,200,3600]
print(stats.mannwhitneyu(a,b,method=stats.PermutationMethod(n_resamples=np.inf)))
print(stats.mannwhitneyu([1,1,1],[1,1,1],method="asymptotic"))
from statsmodels.stats.proportion import proportion_confint
for x,n in [(11,15),(9,15),(0,10),(10,10),(3,7)]:
    print("cp", x, n, proportion_confint(x, n, alpha=0.05, method="beta"))
```

```
MannwhitneyuResult(statistic=np.float64(31.0), pvalue=np.float64(0.18065268065268064))
MannwhitneyuResult(statistic=np.float64(6.0), pvalue=np.float64(0.16666666666666666))
MannwhitneyuResult(statistic=np.float64(4.5), pvalue=np.float64(nan))
cp 11 15 (0.4489967589630295, 0.9221284537089565)
cp 9 15 (0.3228697662062816, 0.8366356761404865)
cp 0 10 (0.0, 0.30849710781876083)
cp 10 10 (0.6915028921812392, 1.0)
cp 3 7 (0.09898827844250786, 0.815948432359917)
```

## What it means for Anybench

- At n=15 per arm, the smallest pass-rate difference detectable at 80% power is 46 pts (at the
  pooled rate of 11/15 vs 9/15), or 49 pts at 50%. "11/15 vs 9/15" is a Newcombe CI of −19 to
  +42 pts: no detectable difference.
- At n=5 no distribution-free 95% CI for a median exists: [min, max] covers 93.75%. The same
  goes for Hodges–Lehmann at 3 vs 3 (90%). We report the level the interval attains.
- In agent kits tasks are the unit. An exact sign-flip test over 3 tasks can't go below p = 0.25,
  so the flagship's 3 tasks can't support any verdict, whatever the repeats. A family of 15
  comparisons needs at least 10 tasks.
