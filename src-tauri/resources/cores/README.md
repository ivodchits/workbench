# Emulator cores

The TV console's Library (office plan O5.3d) plays games through these libretro cores,
built into Workbench (`src/remote/office/library.rs`) and served to the office page only
when a game starts. They are Nostalgist.js's own RetroArch build, the one its
`nostalgist@0.23.0` loads by default:
`https://cdn.jsdelivr.net/gh/arianrhodsandlot/retroarch-emscripten-build@v1.22.2/retroarch/<core>_libretro.zip`.

| Core | System | SHA-256 |
|---|---|---|
| genesis_plus_gx | Mega Drive | `7bd0f36eef6f61e63541a0f51c3ccecb8a7139235d9c3734739acd9c4249b3c8` |
| fceumm | NES | `c890126923a13586b7735c4a551e6010afe06ed059dc8fdeb6b55d8fadf2cf1e` |
| snes9x | SNES | `0d50b0e18607af87c0c6ed2d9068fcfd19514be09b004068c2b5f06783499ef4` |
| gambatte | Game Boy | `a4c40420e8997fb35fe1054452b52c965cc8dd0ab202908e4609f72d560cf5a3` |
| mgba | Game Boy Advance | `d195371c3ea626c9246e9d3ab82ded4d93f3f99f85634af1588724cc44d47644` |

Each core keeps its own licence (Genesis Plus GX and snes9x are non-commercial); Workbench
is a personal tool and doesn't sell them. To update, fetch the same files from a newer
tag together with a matching Nostalgist, and replace the hashes here.
