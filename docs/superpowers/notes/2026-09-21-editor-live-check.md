# Editor group — live end-to-end check

Date: 2026-09-21. Branch `editor-tool-groups`, HEAD 403ab5a. Script: `scripts/editor-live-check.ts`.

Every prior test stubbed `fetch`. This run drives the editor group against
`https://opendata.koumoul.com/data-fair/api/v1` with the global `fetch`, no override.

## Target

- Probe (`/datasets?size=100&select=id,isRest,count`, first `isRest && count > 0`):
  dataset `lpkranejiwf2wxu-8g01xm77` (indice de réparabilité), server-side line
  `c10e93da8b3ec7a1148a97976d0febf3115c288c5863394c6d207db44b3872af`.
- Run: `node scripts/editor-live-check.ts lpkranejiwf2wxu-8g01xm77 c10e93da8b3ec7a1148a97976d0febf3115c288c5863394c6d207db44b3872af`
- No dataset swap was needed: the first candidate's schema compiled, the line validates
  against it (`valid: true, no errors`), and describe/get worked. Live calls: one schema
  GET, one line GET, one PUT (rejected).

## The eight tools

```
dataset_line_getData, dataset_line_setData, dataset_line_describeState,
dataset_line_setFieldValue, dataset_line_getFieldSuggestions, dataset_line_editArray,
dataset_line_saveForm, dataset_line_reloadForm
```

- `JSON.stringify(tools).length` — definition bytes: **5819**
- `instructions.length` — instructions bytes: **228**

`load(doc, { profile: 'write' })` threw nothing; the document's only `x-agent` at load
time is the one the script writes on the PUT, and `readSchema`/`readLine` are reachable
through `resolveOperationById` without their own annotations.

## `describeState` — first 40 lines

The script truncates each result to 1500 chars, so these lines were captured from a
throwaway run of the same annotated document (fetch wrapped only to log request URLs).
The live text is the same.

```
valid: true, no errors

Fields:
- / (section, required)
  - /id_unique (text, required, pattern=^[\w.]+-[\w]+-\d{4}-\d{2}-\d{2}$) label="id_unique" value="3200000003776-320000002-2023-02-28" help="L'identifiant garantissant l'unicité du modèle de produits faisant l'objet d'un indice de réparabilité. Il est obtenu en concaténant l'identifiant du modèle, l'identifiant du fabricant et la date du calcul de l'indice. Les trois éléments sont séparés par un tiret -."
  - /id_modele (text, required, pattern=^[\w.]+$) label="id_modele" value="3200000003776" help="La référence commerciale du modèle ou l'identifiant du modèle"
  - /referentiel_id_modele (combobox, required, values=["GTIN_EAN"]) label="referentiel_id_modele" value="GTIN_EAN" help="Le type de référence utilisé pour l'identifiant du produit selon la norme internationale ISO 15459."
  - /nom_modele (text, required) label="nom_modele" value="roqkryecqf" help="La dénomination officielle du modèle"
  - /categorie_produit (text, required) label="categorie_produit" value="Téléviseur" help="La catégorie du produit selon la nomenclature des catégories définies par arrêté faisant l'objet d'un indice"
  - /id_metteur_sur_le_marche (text, required, pattern=^[\w]+$) label="id_metteur_sur_le_marche" value="320000002" help="L'identifiant du metteur sur le marché"
  - /referentiel_id_metteur_sur_marche (text, required) label="referentiel_id_metteur_sur_marche" value="GLN" help="Le type de référence utilisé pour l'identifiant du metteur sur le marché."
  - /nom_metteur_sur_le_marche (text, required) label="nom_metteur_sur_le_marche" value="asahstmnpr" help="La dénomination officielle du metteur sur le marché"
  - /date_calcul (date, required, format=date, format=date) label="date_calcul" value="2023-02-28" help="La date à laquelle le calcul de l'indice a été effectué"
  - /url_tableau_detail_notation (text, pattern=^(https?)://[^\s/$.?#].[^\s]*$) label="url_tableau_detail_notation" value="http://exemple3.fr/products/mower" help="Le lien vers le tableau du détail de la notation"
  - /note_ir (number, required, min=0, max=10) label="note_ir" value=6.1 help="La note finale de l'indice de réparabilité : note sur 10 comportant une décimale"
  - /note_c1 (number, required, min=0, max=20) label="note_c1" value=14.8 help="La note du critère 1 documentation : note sur 20 comportant une décimale"
  - /note_c2 (number, required, min=0, max=20) label="note_c2" value=18.2 help="La note du critère 2 démontabilité : note sur 20 comportant une décimale"
  - /note_c3 (number, required, min=0, max=20) label="note_c3" value=5.3 help="La note du critère 3 disponibilité des pièces détachées : note sur 20 comportant une décimale"
  - /note_c4 (number, required, min=0, max=20) label="note_c4" value=1.5 help="La note du critère 4 Prix : note sur 20 comportant une décimale"
  - /note_c5 (number, required, min=0, max=20) label="note_c5" value=9.5 help="La note du critère 5 spécifique : note sur 20 comportant une décimale"
  - /note_c2_1 (number, required, min=0, max=10) label="note_c2.1" value=9.1 help="La note du sous-critère 2.1 : note sur 10 comportant une décimale"
  - /note_c2_2 (number, required, min=0, max=10) label="note_c2.2" value=6.2 help="La note du sous-critère 2.2 : note sur 10 comportant une décimale"
  - /note_c2_3 (number, required, min=0, max=10) label="note_c2.3" value=6.9 help="La note du sous-critère 2.3 : note sur 10 comportant une décimale"
  - /note_c3_1 (number, required, min=0, max=10) label="note_c3.1" value=4.3 help="La note du sous-critère 3.1 : note sur 10 comportant une décimale"
  - /note_c3_2 (number, required, min=0, max=10) label="note_c3.2" value=3.7 help="La note du sous-critère 3.2 : note sur 10 comportant une décimale"
  - /note_c3_3 (number, required, min=0, max=10) label="note_c3.3" value=7.3 help="La note du sous-critère 3.3 : note sur 10 comportant une décimale"
  - /note_c3_4 (number, required, min=0, max=10) label="note_c3.4" value=5 help="La note du sous-critère 3.4 : note sur 10 comportant une décimale"
  - /note_c5_1 (number, required, min=0, max=10) label="note_c5.1" value=5.9 help="La note du sous-critère 5.1 : note sur 10 comportant une décimale"
  - /note_c5_2 (number, min=0, max=10) label="note_c5.2" value=6.1 help="La note du sous-critère 5.2 (le cas échéant) : note sur 10 comportant une décimale"
  - /note_c5_3 (number, min=0, max=10) label="note_c5.3" value=5.1 help="La note du sous-critère 5.3 (le cas échéant) : note sur 10 comportant une décimale"
  - /lien_documentation (text, pattern=^(https?)://[^\s/$.?#].[^\s]*$) label="lien_documentation" value="http://exemple3.fr/products/mower/caracteristics" help="Le lien vers la documentation technique disponible (ou modalités d'accès)"
  - /nom_piece_detachee_1_reparateur (text) label="nom_piece_detachee_1_reparateur" value="Moteur d'aspiration" help="Le nom de la pièce détachée n°1 de la liste 2 pour les reparateurs"
  - /delai_jours_piece_detachee_1_reparateur (text) label="delai_jours_piece_detachee_1_reparateur" value="<10" help="Le délai de livraison (en jours) de la pièce détachée n°1 de la liste 2 pour les reparateurs"
  - /nb_annees_disponibilite_piece_detachee_1_reparateur (text) label="nb_annees_disponibilite_piece_detachee_1_reparateur" value="9" help="L'engagement (en années) de mise à disposition à partir de la date de mise sur le marché de la pièce détachée n°1 de la liste 2 pour les reparateurs"
  - /nom_piece_detachee_2_reparateur (text) label="nom_piece_detachee_2_reparateur" value="Conduites et matériel connexe (incluant l'ensemble des flexibles, vannes, filtres et systèmes aquastop)" help="Le nom de la pièce détachée n°2 de la liste 2 pour les reparateurs"
  - /delai_jours_piece_detachee_2_reparateur (text) label="delai_jours_piece_detachee_2_reparateur" value="<3" help="Le délai de livraison (en jours) de la pièce détachée n°2 de la liste 2 pour les reparateurs"
  - /nb_annees_disponibilite_piece_detachee_2_reparateur (text) label="nb_annees_disponibilite_piece_detachee_2_reparateur" value="7" help="L'engagement (en années) de mise à disposition à partir de la date de mise sur le marché de la pièce détachée n°2 de la liste 2 pour les reparateurs"
  - /nom_piece_detachee_3_reparateur (text) label="nom_piece_detachee_3_reparateur" value="Tête d'aspiration" help="Le nom de la pièce détachée n°3 de la liste 2 pour les reparateurs"
  - /delai_jours_piece_detachee_3_reparateur (text) label="delai_jours_piece_detachee_3_reparateur" value="<10" help="Le délai de livraison (en jours) de la pièce détachée n°3 de la liste 2 pour les reparateurs"
  - /nb_annees_disponibilite_piece_detachee_3_reparateur (text) label="nb_annees_disponibilite_piece_detachee_3_reparateur" value="<9" help="L'engagement (en années) de mise à disposition à partir de la date de mise sur le marché de la pièce détachée n°3 de la liste 2 pour les reparateurs"
```

`getData` returned the stored line as JSON: `_id` plus the columns above (`refers`-free,
plain values), truncated at 1500 chars by the harness.

## `saveForm` — expected outcome, confirmed

```
ERROR: Error: PUT https://opendata.koumoul.com/data-fair/api/v1/datasets/lpkranejiwf2wxu-8g01xm77/lines/c10e93da8b3ec7a1148a97976d0febf3115c288c5863394c6d207db44b3872af failed: 403 Permission manquante pour l'opération "updateLine" ou la catégorie "write".
```

`isError: true`, returned as a result — nothing thrown out of `execute`. A 403 is the
expected outcome: no write token in this harness. Everything up to the save worked.

## Findings

1. **`saveForm` 401/403 as an error result — observed as expected.** The package's
   `save` throws, `bridgeTool` catches it (`src/editor/bridge.ts:49-52`) and returns
   `{ isError: true, text: 'Error: …' }`. Matches the brief's expectation.
2. **`instructions` is the fallback, not core's `generateSkill` — recorded spec
   divergence.** The section is exactly:

   ```
   ## dataset_line

   Tools: dataset_line_getData, dataset_line_setData, dataset_line_describeState, dataset_line_setFieldValue, dataset_line_getFieldSuggestions, dataset_line_editArray, dataset_line_saveForm, dataset_line_reloadForm
   ```

   `generateSkill` is not publicly exported by `@json-layout/core` (checked at runtime:
   `import * as core` exposes no `skill`/`generate` keys) and `includeFillFormSkill` stays
   false, so `load.ts:160-166` builds the `## <toolName> / Tools: …` section itself. This
   is the plan's fallback, not a surprise.
3. **`extension=true` does reach the schema request, even though `readSchema` does not
   declare the parameter.** The fixture's `readSchema` params are `mimeType, type, format,
   capability, enum, calculated`; `editorRequest` (`src/editor/operations.ts:50-53`) adds
   unknown `schemaParams` keys as query bindings anyway. A wrapped-fetch run captured:

   ```
   GET https://opendata.koumoul.com/data-fair/api/v1/datasets/lpkranejiwf2wxu-8g01xm77/schema?mimeType=application%2Fschema%2Bjson&extension=true
   GET https://opendata.koumoul.com/data-fair/api/v1/datasets/lpkranejiwf2wxu-8g01xm77/lines/c10e93da8b3ec7a1148a97976d0febf3115c288c5863394c6d207db44b3872af
   ```

4. **`prepareSchema` had nothing to hide for this dataset.** The fetched schema
   (`mimeType=application/schema+json&extension=true`) has 207 top-level properties and
   zero `x-extension` and zero `x-refersTo` nodes at any depth; fetching with and without
   `extension=true` returned identical property sets. So the run exercised the schema
   path, but not the attachment/extension hiding branch.
5. **Surprise: `describeState` prints `format=date` twice** for `/date_calcul`
   (`format=date, format=date`), while the raw fetched schema has a single
   `format: "date"`. This rendering comes from the package's `describeState`, not from
   `src/`. No explanation; recorded because it is a surprise.
6. **Surprise-by-omission: no defect surfaced in `src/`.** Nothing in the live run
   contradicted the stub-based tests. No fix task warranted from this evidence.
