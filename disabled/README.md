To disable an extension without deleting it, move it under this directory:

```text
pi-extensions/
├── 00-enabled-extension/
│   └── index.ts          # loaded
└── disabled/
    └── disabled-extension/
        └── index.ts      # not loaded
```
