# Sports car credits

The sports car models listed in `manifest.sports.json` are third-party 3D models licensed under
[Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/) (CC BY 4.0).
Each license was re-checked on 2026-10-17: the Sketchfab models against the live Sketchfab API
(`api.sketchfab.com/v3/models/<uid>`), and the Khronos model against its `LICENSE.md`. Each GLB also
carries its credit in `asset.extras`.

**Changes made (all models):** re-oriented to +Z forward / +Y up and scaled to real-world meters;
the hierarchy rebuilt into one body plus four wheel pivot nodes at the wheel centers (merged wheels split
per corner, wheels posed as steered reset to straight, an open door closed on the 992); stray ground and
shadow planes removed; some lamp materials split into front/rear copies and renamed; geometry welded and
partly decimated; textures resized to 1024 px or less and re-encoded as WebP; meshopt-compressed.
The original authors do not endorse this project.

**Trademarks:** these models depict real vehicles (Porsche 911 / 930, BMW M3 E30, M3 E46, M4 CSL), and
some carry maker badges, crests or brand stickers. CC BY covers the 3D artwork only. It does not cover
trademark or trade-dress rights in the vehicle designs, names or logos. The Khronos logos on the Car Concept
are Khronos Group trademarks and are excluded from its license. `manifest.sports.json` → `logos` lists the
materials that carry badges so they can be hidden.

| File | Vehicle | Author | License |
|---|---|---|---|
| `porsche_992_turbo_s.glb` | Porsche 911 Turbo S (992), with interior | [n.brizitskaya](https://sketchfab.com/n.brizitskaya) | CC BY 4.0 |
| `porsche_930_turbo.glb` | Porsche 911 Turbo (930), 1975 | [Lionsharp Studios / Karol Miklas](https://sketchfab.com/lionsharp) | CC BY 4.0 |
| `bmw_e30_m3.glb` | BMW M3 (E30) | [Martin Trafas (TinoD2)](https://sketchfab.com/TinoD2) | CC BY 4.0 |
| `bmw_e46_m3.glb` | BMW M3 (E46) | [Márcio Meireles (MMC Works)](https://sketchfab.com/marciomeireles) | CC BY 4.0 |
| `bmw_m4_csl.glb` | BMW M4 CSL (G82) | [Mpgs Studios](https://sketchfab.com/mpgs.studio) | CC BY 4.0 |
| `concept_car_khronos.glb` | Car Concept (fictional concept supercar) | Darmstadt Graphics Group GmbH / Eric Chadwick | CC BY 4.0 (logos excluded) |

## Attribution text

- **porsche_992_turbo_s.glb**: This work is based on "Porsche 911 with interior" (https://sketchfab.com/3d-models/porsche-911-with-interior-877b1bc1739f4a2bb65d62fd7ffd9f75) by n.brizitskaya (https://sketchfab.com/n.brizitskaya) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)
- **porsche_930_turbo.glb**: This work is based on "FREE 1975 Porsche 911 (930) Turbo" (https://sketchfab.com/3d-models/free-1975-porsche-911-930-turbo-8568d9d14a994b9cae59499f0dbed21e) by Karol Miklas (https://sketchfab.com/karolmiklas) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)
  - The author now publishes as Lionsharp Studios (https://sketchfab.com/lionsharp) and asks to be credited as "Lionsharp Studios".
- **bmw_e30_m3.glb**: This work is based on "[FREE] BMW M3 E30" (https://sketchfab.com/3d-models/free-bmw-m3-e30-ac3c7013434e403e8faff87948caf422) by Martin Trafas (https://sketchfab.com/Bexxie) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)
  - The author's current Sketchfab profile is https://sketchfab.com/TinoD2.
- **bmw_e46_m3.glb**: This work is based on "BMW M3 E46" (https://sketchfab.com/3d-models/bmw-m3-e46-f1b00ff37d504629b10031da32bc7497) by Márcio Meireles (https://sketchfab.com/marciomeireles) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)
- **bmw_m4_csl.glb**: This work is based on "BMW M4csl" (https://sketchfab.com/3d-models/bmw-m4csl-b53782a00cc240a191d5d7d005af1423) by Mpgs Studios (https://sketchfab.com/mpgs.studio) licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)
- **concept_car_khronos.glb**: "Car Concept" © 2024 Darmstadt Graphics Group GmbH, model and textures by Eric Chadwick (based on the public-domain "FREE Concept Car 004" by Unity Fan), from the Khronos glTF Sample Assets (https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CarConcept), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Khronos logos are trademarks of the Khronos Group and are not covered by the license.

## Where the files were fetched from

Sketchfab downloads need a login, so each model was fetched from a public copy of the author's original
download. The license on that copy matches the live Sketchfab listing.

- 992 Turbo S: GitHub `nalostta/aworld` @ c014b6f (`static/models/Porsche_911_Interior/`)
- 930 Turbo: GitHub `PacktPublishing/Learn-Three.js-Fourth-edition` @ d007349 (`source/assets/gltf/porsche/`)
- M3 E30: GitHub `Monnte/car-dataset-generator` @ 3948fed (`assets/models/bmw/`)
- M3 E46: Objaverse mirror on Hugging Face (`allenai/objaverse`, `glbs/000-119/f1b00ff37d504629b10031da32bc7497.glb`)
- M4 CSL: GitHub `volodya-rua/NetherFlow` @ 072a194 (`race/cars/m4-csl.glb`). That repo's code is GPL-3.0, and it credits the model as CC BY 4.0 by Mpgs Studios. Its copy had already been meshopt-compressed and had its textures removed.
- Car Concept: GitHub `KhronosGroup/glTF-Sample-Assets` @ edc7c9e (`Models/CarConcept/glTF-Binary/CarConcept.glb`)
