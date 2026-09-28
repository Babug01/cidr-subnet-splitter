# CIDR Subnet Splitter

**Live demo:** https://cidr-subnet-splitter.vercel.app (Vercel) · [GitHub Pages mirror](https://babug01.github.io/cidr-subnet-splitter/)

A subnet-planning tool that goes a step past a basic CIDR calculator: split a parent block into equal-size
subnets, allocate a VLSM-style plan from a list of host-count requirements, or check a batch of CIDR blocks
for overlaps. Runs entirely in the browser; nothing you paste ever leaves your machine.

## Features

- **Split into N equal-size subnets** — enter a parent CIDR and a subnet count, get the resulting prefix
  length plus each subnet's network address, first/last usable host, broadcast address, and usable host
  count. If the requested count isn't a power of two, this says so explicitly and shows which blocks from
  the actual (rounded-up) split are unused, rather than silently pretending an exact split happened.
- **VLSM allocation by host counts** — paste a list of desired host counts, one per line; allocates
  greedily from the largest requirement first so each subnet is only as big as it needs to be. Clearly
  flags any requirement that doesn't fit once the parent block runs out of room, instead of failing
  silently or producing overlapping ranges.
- **Overlap checker** — paste a list of CIDR blocks, one per line, and every pairwise overlap is flagged by
  comparing address integer ranges (so a `/25` fully nested inside a `/24` is still caught, not just
  identical or partially-overlapping blocks).

## Tech Stack

- [React](https://react.dev/) + [Vite](https://vitejs.dev/) — no other runtime dependencies; all IPv4/CIDR
  arithmetic is plain JS bit math, adapted from this portfolio's IP & CIDR Toolkit so the two tools agree.

## Running locally

```bash
git clone https://github.com/Babug01/cidr-subnet-splitter.git
cd cidr-subnet-splitter
npm install
npm run dev
```

## License

MIT — see [LICENSE](LICENSE).
