#!/usr/bin/env bash
# Thin wrapper, the house standard (site-conformance: standard-deploy-wrapper).
# It redeploys the CURRENT checkout through ~/bin/deploy-site: build gate,
# reload by file, verify. Releasing a new version is scripts/release.sh, which
# adds the check-suite gate, migrations, version proof and automatic undo.
exec /home/randall/bin/deploy-site projectnoosphere "$@"
