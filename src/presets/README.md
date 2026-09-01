# Built-in presets

The public preset catalog is available only from
`@darkroom/core/presets`. The package root does not import or
initialize the catalog.

```ts
import { applyLook } from '@darkroom/core';
import { compilePreset, getPreset } from '@darkroom/core/presets';

const metadata = getPreset('tealOrange');
const look = compilePreset('tealOrange', { lutSize: 33 });
const output = applyLook(input, look, 80);
```

`presets` and all returned metadata are immutable. `compilePreset` is lazy and
returns a generic engine `Look`; the private film-response parameter tables are
not part of the compatibility contract.

Product and company names remain the property of their respective owners.
The built-in looks are independently authored creative approximations. Their
names describe inspiration only and do not imply affiliation, certification,
endorsement, or colorimetric equivalence to any film stock, scanner, product,
or service.
