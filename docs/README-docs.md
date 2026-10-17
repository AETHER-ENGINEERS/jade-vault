# Jade Vault documentation

Jade Vault is a device-local Markdown vault with an AI assistant, browser-based scripting, automations, and an Android wrapper. These guides target **Jade Vault 2.8.0**; UI labels may vary slightly between releases. Config has Model, Memory, Tools, Connect, and App tabs, plus a search box.

## Version baseline

Cross-checked against source commit [`cdf68ef883a3ebef81c4df6e1e9a51ad8248f629`](https://github.com/AETHER-ENGINEERS/jade-vault/tree/cdf68ef883a3ebef81c4df6e1e9a51ad8248f629), which declares version **2.8.0** and Android version code **22**. See the [verification record](repository-comparison.md) for review scope and limitations.

> These pages document the 2.8.0 release, not whichever revision happens to be checked out locally. This documentation branch still contains older 2.7.3 application source and a 2.7.3 hosted page; neither was upgraded by editing the docs. Use a 2.8.0 installation/source checkout for the instructions below, especially Discord. Relative source links open this branch's files; pinned links in the verification record identify the exact reviewed source.

## Start here

1. [Install and get started](getting-started.md).
2. [Configure a model provider](configuration.md).
3. [Write and organize notes](notes.md).
4. [Back up your data](backup-and-storage.md).

## User and integration guides

| Page | Contents |
| --- | --- |
| [Getting started](getting-started.md) | Browser and Android installation, first conversation, offline limits |
| [Configuration and providers](configuration.md) | Ollama, cloud providers, llama.cpp, AICord, fallbacks, secrets |
| [Notes and knowledge management](notes.md) | Markdown, links, tags, search, graph, images, attachments |
| [Jade, memory, and skills](jade-and-memory.md) | Chat, tools, steering files, journal, skills, context management |
| [Shell and scripting](scripting.md) | BusyBox, JavaScript bridge, MicroPython, SQLite, TensorFlow.js |
| [Note scripts and templates](note-scripts-and-templates.md) | Dataview-style queries, inline expressions, Templater syntax |
| [Flows and scheduling](automation.md) | Flow JSON reference, expressions, schedules, crontab, heartbeat |
| [MCP and HTTP integrations](integrations.md) | MCP configuration, tool exposure, resources, HTTP requests |
| [Apps and Jade Link](apps.md) | Sandboxed webxdc apps, update protocol, packaging |
| [Discord](discord.md) | Bot creation, bridge setup, permissions, shared queue, diagnostics |
| [Vector messenger](vector.md) | Bridge setup, Docker, account ownership, roles, network safety |
| [Android HTTP API](http-api.md) | Authentication, routes, parameters, examples, error handling |
| [Backups and storage](backup-and-storage.md) | Full/config exports, restore, migration, separate data stores |
| [Security and privacy](security-and-privacy.md) | Data boundaries, credentials, code execution, licenses |
| [Troubleshooting](troubleshooting.md) | Provider, storage, automation, bridge, API, build problems |

## Developer and build guides

| Page | Contents |
| --- | --- |
| [Development and architecture](development.md) | Repository map, build pipeline, local serving, tests, contribution checklist |
| [Build the Android APK](android-apk.md) | Required tools, debug build, release keystore, signing, installation, upgrades |
| [Deployment and releases](deployment-and-releases.md) | Static hosting, GitHub Pages asset, release artifacts, CI and signing secrets |
| [Documentation verification record](repository-comparison.md) | 2.8.0 source baseline, coverage review, checks performed, known limitations |

## Existing project references

- [Project README](../README.md), [changelog](../CHANGELOG.md), and [version](../VERSION).
- [Existing browser deployment README](README.md) and [browser application](index.html).
- [Security policy](../SECURITY.md), [license](../LICENSE), and [third-party notices](../THIRD_PARTY_NOTICES.md).
- [Vector bridge reference](../jade-vector/README.md).
- [Jade Link protocol](../apps/jade-link/README.md).
- [SQLite WebAssembly build reference](../sqlite-wasm/README.md).

> Paths such as `/Jade/SOUL.md` are files **inside the app's virtual vault**, not files in this Git checkout. Commands in build/development guides run on your computer; commands in scripting guides run inside Jade Vault unless explicitly stated otherwise.
