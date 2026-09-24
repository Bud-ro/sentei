# Build helper for @acme/tool-py. Calls into @acme/y through node; sentei cannot
# index Python, so @acme/tool-py is flagged unindexed_consumer (PLAN.md §2).
import subprocess

subprocess.run(
    ["node", "--input-type=module", "-e", "import('@acme/y').then((m) => console.log(m.yUnused()))"],
    check=True,
)
