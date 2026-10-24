# Is retrieval similarity / vote agreement a usable confidence signal? Which intents get confused?
import sys, re, numpy as np, pandas as pd
from collections import Counter
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import linear_kernel
from statsmodels.stats.proportion import proportion_confint
df = pd.read_csv(sys.argv[1])
norm = lambda s: re.sub(r"\s+", " ", re.sub(r"\{\{[^}]+\}\}", "<slot>", s.lower())).strip(" ?.!")
df["n"] = df.instruction.map(norm)
rows = []
for seed in (1, 2, 3):
    pool = df.drop_duplicates("n").sample(frac=1, random_state=seed)
    kb, cand = pool.iloc[:2000], pool.iloc[2000:]
    vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(3,5), sublinear_tf=True).fit(pd.concat([kb.n, cand.n]))
    sims = linear_kernel(vec.transform(cand.n), vec.transform(kb.n))
    keep = sims.max(1) < 0.8
    cand, sims = cand[keep], sims[keep]
    idx = cand.reset_index(drop=True).groupby("intent").sample(40, random_state=seed).index
    for i in idx:
        top5 = np.argsort(-sims[i])[:5]
        labs = kb.intent.values[top5]
        lab, votes = Counter(labs).most_common(1)[0]
        rows.append(dict(true=cand.intent.values[i], pred=lab, votes=votes, best=sims[i][top5[0]], flags=cand["flags"].values[i]))
r = pd.DataFrame(rows); r["ok"] = r.true == r.pred
print("n =", len(r), "acc =", f"{r.ok.mean():.1%}")
print("\naccuracy by top-5 vote agreement:")
print(r.groupby("votes").ok.agg(["count", "mean"]).to_string())
print("\naccuracy by best similarity bucket:")
print(r.groupby(pd.cut(r.best, [0, .4, .5, .6, .7, .8])).ok.agg(["count", "mean"]).to_string())
for t in (5, 4):
    s = r[r.votes >= t]; print(f"\nanswer only if votes>={t}: coverage={len(s)/len(r):.1%} acc={s.ok.mean():.1%}")
print("\ntop confusions:", Counter(zip(r[~r.ok].true, r[~r.ok].pred)).most_common(8))
r["Q"] = r["flags"].str.contains("Q"); r["K"] = r["flags"].str.contains("K"); r["W"] = r["flags"].str.contains("W")
for f in "QKW": print(f"acc when flag {f}: {r[r[f]].ok.mean():.1%} (n={r[f].sum()})")
print("\nWilson 95% CI for k/30:")
for k in (30, 29, 28, 27, 25):
    lo, hi = proportion_confint(k, 30, method="wilson"); print(f"  {k}/30 = {k/30:.1%}  CI [{lo:.1%}, {hi:.1%}]")
