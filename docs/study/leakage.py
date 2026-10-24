# Leakage check for KB / held-out split + retrieval-only intent baseline.
import sys, re, numpy as np, pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import linear_kernel
df = pd.read_csv(sys.argv[1])
print(df.groupby("category").intent.unique().to_string())
norm = lambda s: re.sub(r"\s+", " ", re.sub(r"\{\{[^}]+\}\}", "<slot>", s.lower())).strip(" ?.!")
df["n"] = df.instruction.map(norm)
print("distinct normalized (slots collapsed):", df.n.nunique(), "of", len(df))

def run(name, kb, ho, seed):
    vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(3,5), sublinear_tf=True).fit(pd.concat([kb.n, ho.n]))
    K, H = vec.transform(kb.n), vec.transform(ho.n)
    sims = linear_kernel(H, K)
    top = sims.argmax(1); best = sims.max(1)
    exact = ho.n.isin(set(kb.n)).mean()
    acc1 = (kb.intent.values[top] == ho.intent.values).mean()
    # top-5 majority vote
    top5 = np.argsort(-sims, 1)[:, :5]
    vote = [pd.Series(kb.intent.values[r]).mode()[0] for r in top5]
    acc5 = (np.array(vote) == ho.intent.values).mean()
    print(f"{name:34s} seed={seed} n={len(ho):4d} kb={len(kb):5d} exact_dup={exact:5.1%} "
          f"cos>=0.9={np.mean(best>=0.9):5.1%} cos>=0.8={np.mean(best>=0.8):5.1%} median_best={np.median(best):.2f} "
          f"kNN1_acc={acc1:5.1%} kNN5_acc={acc5:5.1%}")
    return best, ho

for seed in (1, 2, 3):
    rng = np.random.default_rng(seed)
    # A) naive: random rows, ~1 per intent + 3 extra = 30; KB = 2000 random others
    ho = df.groupby("intent", group_keys=False).sample(1, random_state=seed)
    ho = pd.concat([ho, df.drop(ho.index).sample(3, random_state=seed)])
    rest = df.drop(ho.index)
    run("A naive, KB=2000", rest.sample(2000, random_state=seed), ho, seed)
    run("A naive, KB=all rest", rest, ho, seed)
    # B) hardened: dedupe on normalized text, hold out only items whose best KB match < 0.8
    d = df.drop_duplicates("n")
    pool = d.sample(frac=1, random_state=seed)
    kb = pool.iloc[:2000]
    cand = pool.iloc[2000:]
    cand = cand[~cand.n.isin(set(kb.n))]
    vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(3,5), sublinear_tf=True).fit(pd.concat([kb.n, cand.n]))
    best = linear_kernel(vec.transform(cand.n), vec.transform(kb.n)).max(1)
    cand = cand[best < 0.8]
    ho = cand.groupby("intent", group_keys=False).sample(1, random_state=seed)
    ho = pd.concat([ho, cand.drop(ho.index).sample(3, random_state=seed)])
    run("B dedup + <0.8 filter, KB=2000", kb, ho, seed)
    # Larger held-out to get stable baseline estimates
    big = cand.groupby("intent", group_keys=False).sample(20, random_state=seed)
    run("B (n=540 for stable estimate)", kb, big, seed)
