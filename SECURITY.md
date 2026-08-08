# Security policy

## Supported versions

Darkroom has not published a stable npm package. Security fixes are applied to the latest revision of the `main` branch and to the currently deployed application.

After a package is released, this table will be updated with its supported versions. Until 1.0, only the latest published `0.x` minor line will receive security fixes.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Submit a [private GitHub security advisory](https://github.com/Yasirdora/darkroom/security/advisories/new) with:

- the affected revision, URL, browser, and operating system;
- a minimal reproduction or proof of concept;
- the realistic impact and attack scenario;
- any known workaround or mitigation.

You should receive an acknowledgement within five business days. Please allow a reasonable remediation window before public disclosure.

## Security and privacy scope

Darkroom processes user-selected images locally and does not intentionally upload their pixels or grading state to an application service. Browser, hosting, extension, and consumer-application behavior remains outside the engine's control.

Treat filenames, image metadata, shared-grade parameters, imported LUT text, export names, and generated text as untrusted. Consumers must validate those values before inserting them into HTML, file paths, logs, URLs, or shell commands. Resource limits are also security boundaries: compressed images and LUT files can expand substantially in memory.
