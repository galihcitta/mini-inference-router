# Builds the KB / eval / dev split from the Bitext CSV (see docs/mini-inference-router-study.md).
# Deduplicate on normalized text, then hold out only questions whose closest KB match is below
# cos 0.8, so the eval can't be answered by near-copy lookup. Fixed seed.
# Usage: python scripts/make_split.py <csv> [out_dir]
import sys, re, json, pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import linear_kernel

SEED = 7
df = pd.read_csv(sys.argv[1])
out = sys.argv[2] if len(sys.argv) > 2 else "data"
norm = lambda s: re.sub(r"\s+", " ", re.sub(r"\{\{[^}]+\}\}", "<slot>", s.lower())).strip(" ?.!")
df["n"] = df.instruction.map(norm)
d = df.drop_duplicates("n").sample(frac=1, random_state=SEED)

kb = d.groupby("intent", group_keys=False).head(74)  # 27 x 74 = 1,998
cand = d.drop(kb.index)
cand = cand[~cand.n.isin(set(kb.n))]
vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), sublinear_tf=True).fit(pd.concat([kb.n, cand.n]))
best = linear_kernel(vec.transform(cand.n), vec.transform(kb.n)).max(1)
cand = cand[best < 0.8]

ev = cand.groupby("intent", group_keys=False).sample(1, random_state=SEED)
kw = cand.drop(ev.index)
kw = kw[kw["flags"].str.contains("K")].sample(3, random_state=SEED)
ev = pd.concat([ev, kw])
dev = cand.drop(ev.index).groupby("intent", group_keys=False).sample(11, random_state=SEED)  # 297

def dump(frame, name, with_answer):
    with open(f"{out}/{name}", "w") as f:
        for i, r in frame.iterrows():
            row = {"id": int(i), "question": r.instruction, "intent": r.intent, "category": r.category, "flags": r["flags"]}
            if with_answer:
                row["answer"] = r.response
            f.write(json.dumps(row) + "\n")

dump(kb, "kb.jsonl", True)
dump(ev, "eval.jsonl", False)
dump(dev, "dev.jsonl", False)
print(f"kb={len(kb)} eval={len(ev)} dev={len(dev)} filtered_pool={len(cand)}")
