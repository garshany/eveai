# Evidence: repo-knowledge-map

## Overall

- Status: PASS
- Basis: AC1-AC5 are all proven in the current repository state.

## AC1

- Status: PASS
- Criterion: Root `AGENTS.md` is a short navigation map, not a long-form manual; it clearly points agents to the deeper repo sources of truth and stays scoped to durable routing/invariant guidance rather than duplicating the full repository knowledge base.
- Proof:
  - [`AGENTS.md`](/home/antipedik/eveai/AGENTS.md) is 90 lines according to `.agent/tasks/repo-knowledge-map/raw/lint.txt`.
  - [`AGENTS.md`](/home/antipedik/eveai/AGENTS.md) contains routing sections `Start Here`, `Deep Links`, `Repo Map`, and `Working Rules` instead of a monolithic manual; see `.agent/tasks/repo-knowledge-map/raw/test-unit.txt`.
  - [`AGENTS.md`](/home/antipedik/eveai/AGENTS.md) now points to [`docs/index.md`](/home/antipedik/eveai/docs/index.md), [`docs/repo-map.md`](/home/antipedik/eveai/docs/repo-map.md), and the existing indexed docs.

## AC2

- Status: PASS
- Criterion: `docs/` is the canonical knowledge store for the repository, with indexed and discoverable entries for architecture, product sense, design, reliability, security, deployment, generated schema, design docs, product specs, and exec plans.
- Proof:
  - [`docs/index.md`](/home/antipedik/eveai/docs/index.md) explicitly states that `docs/` is the repository knowledge system of record.
  - `.agent/tasks/repo-knowledge-map/raw/test-integration.txt` contains the current `find docs -maxdepth 3 -type f | sort` output, proving the indexed docs tree includes top-level docs, `design-docs/`, `product-specs/`, `exec-plans/`, `generated/`, and `references/`.
  - [`AGENTS.md`](/home/antipedik/eveai/AGENTS.md) and [`ARCHITECTURE.md`](/home/antipedik/eveai/ARCHITECTURE.md) both deep-link into this docs structure; see `.agent/tasks/repo-knowledge-map/raw/test-unit.txt`.

## AC3

- Status: PASS
- Criterion: The repository has an explicit file-and-domain map that lets an agent quickly find the major code areas, supporting docs, and operational surfaces without reading unrelated files first.
- Proof:
  - [`docs/repo-map.md`](/home/antipedik/eveai/docs/repo-map.md) is a dedicated fast file-and-domain map.
  - `.agent/tasks/repo-knowledge-map/raw/test-integration.txt` contains the full current contents of [`docs/repo-map.md`](/home/antipedik/eveai/docs/repo-map.md), showing root entrypoints, runtime domains, browser surface, tests, deployment/ops, repo-local knowledge, and local skills.
  - [`AGENTS.md`](/home/antipedik/eveai/AGENTS.md) now routes directly to [`docs/repo-map.md`](/home/antipedik/eveai/docs/repo-map.md).

## AC4

- Status: PASS
- Criterion: The documentation structure reflects progressive disclosure from the OpenAI article: stable entrypoint first, then indexed deep links, then domain-specific docs and versioned plans/tech-debt artifacts.
- Proof:
  - [`docs/index.md`](/home/antipedik/eveai/docs/index.md) provides `Stable Entry Points`, `Top-Level Docs`, `Indexed Subtrees`, and `Reading Order By Question`.
  - [`ARCHITECTURE.md`](/home/antipedik/eveai/ARCHITECTURE.md) now has `How To Read This Repo` and explicitly describes the knowledge model as progressive disclosure; see `.agent/tasks/repo-knowledge-map/raw/test-unit.txt`.
  - [`docs/PLANS.md`](/home/antipedik/eveai/docs/PLANS.md), [`docs/exec-plans/active/index.md`](/home/antipedik/eveai/docs/exec-plans/active/index.md), [`docs/exec-plans/completed/index.md`](/home/antipedik/eveai/docs/exec-plans/completed/index.md), and [`docs/exec-plans/tech-debt-tracker.md`](/home/antipedik/eveai/docs/exec-plans/tech-debt-tracker.md) remain versioned plan/debt artifacts discoverable from the docs catalog.

## AC5

- Status: PASS
- Criterion: Any ambiguity about `agent.md` is resolved consistently in the repo and spec: the existing `AGENTS.md` remains the root map, and no separate `agent.md` file is introduced unless a concrete repo need is proven.
- Proof:
  - [`.agent/tasks/repo-knowledge-map/spec.md`](/home/antipedik/eveai/.agent/tasks/repo-knowledge-map/spec.md) resolves the ambiguity in favor of `AGENTS.md` as the canonical root map.
  - [`AGENTS.md`](/home/antipedik/eveai/AGENTS.md) remains the root map and routes to the deeper docs.
  - `.agent/tasks/repo-knowledge-map/raw/lint.txt` includes `find . -maxdepth 2 ( -iname 'agent.md' -o -iname 'AGENT.md' )`, which returned no separate `agent.md` candidate.

## Commands Run

- `git diff --check -- AGENTS.md ARCHITECTURE.md docs/index.md docs/repo-map.md docs/design-docs/index.md docs/product-specs/index.md docs/PLANS.md docs/QUALITY_SCORE.md`
- `rg -n "docs/index.md|docs/repo-map.md|system of record|root map|progressive disclosure" AGENTS.md ARCHITECTURE.md docs`
- `find docs -maxdepth 3 -type f | sort`
- `sed -n '1,220p' docs/index.md`
- `sed -n '1,260p' docs/repo-map.md`
- `git diff --stat -- AGENTS.md ARCHITECTURE.md docs/index.md docs/repo-map.md docs/design-docs/index.md docs/product-specs/index.md docs/PLANS.md docs/QUALITY_SCORE.md`
- `git status --short`
- `wc -l AGENTS.md`
- `find . -maxdepth 2 ( -iname 'agent.md' -o -iname 'AGENT.md' ) | sort`

## Raw Artifacts

- [build.txt](/home/antipedik/eveai/.agent/tasks/repo-knowledge-map/raw/build.txt)
- [test-unit.txt](/home/antipedik/eveai/.agent/tasks/repo-knowledge-map/raw/test-unit.txt)
- [test-integration.txt](/home/antipedik/eveai/.agent/tasks/repo-knowledge-map/raw/test-integration.txt)
- [lint.txt](/home/antipedik/eveai/.agent/tasks/repo-knowledge-map/raw/lint.txt)
