# Bolt UI Recovery Payload

This branch contains the recovered Bolt UI/UX state, encoded as 11 ordered Base64 chunks of one XZ-compressed authoritative TXT replacement patch.

## Baseline

`96c1d2185c7fc99c74088f9690f58cc6664425d3`

## Reconstruct the authoritative TXT

From the repository root, run:

```bash
python - <<'PY'
from pathlib import Path
import base64, lzma

root = Path('docs/bolt-ui-recovery')
parts = ''.join((root / f'part-{i:02d}.b64').read_text(encoding='utf-8') for i in range(1, 12))
data = lzma.decompress(base64.b64decode(parts))
out = Path('/tmp/Bolt_UI_Recovered_TXT_Patch.txt')
out.write_bytes(data)
print(out)
print('bytes:', len(data))
PY
```

Then read `/tmp/Bolt_UI_Recovered_TXT_Patch.txt` and apply it exactly as instructed inside the file.

## Rules

- Treat the reconstructed TXT as the authoritative recovered Bolt UI state.
- Do not restart the redesign from scratch.
- Do not substitute the clean WO3 UI state.
- Apply on top of the exact baseline above.
- Continue only the remaining UI/UX work after the recovered state is applied.
- Preserve all business/domain/provider/voice/session/persistence/review/evidence/assessment/adaptive-learning logic.
- Do not modify `main` directly and do not merge.
