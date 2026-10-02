# Boosted Box Fulfillment Review - {{location_name}}

**Canonical Slack request:** `{{canonical_thread_ts}}`
**Slack thread:** [Open request thread]({{slack_thread_url}})
**Account:** {{account_name}} (`{{account_id}}`)
**Location:** {{location_name}}, {{street_address}}, {{city}}, {{state}} {{postal_code}}
**V2 location:** `{{location_id}}`
**Account admin:** [Open Boostly account]({{account_admin_url}})
**Location admin:** [Open location]({{location_admin_url}})
**Link editor:** [Open Link/Product editor]({{link_editor_url}})
**Customer-facing link tree:** {{customer_link_tree}}
**Link-tree screenshot:** {{link_tree_screenshot_status}}
**Official website:** {{website_url}}
**Branding case:** `{{branding_case_id}}`

## Fulfillment result

- **Links applied:** {{links_applied}}
- **Links held:** {{links_held_with_category_url_and_review_reason}}
- **Branding:** {{branding_outcome}}
- **Branding flags:** {{branding_flags}}
- **Badges requested:** {{badges_requested}}
- **Badge readback:** {{badge_readback}}
- **Proof artifact:** `{{proof_path}}`
- **Link-tree screenshot:** `{{link_tree_screenshot_path_or_unavailable_reason}}`
- **Manifest:** `{{manifest_path}}`
- **GBP photo manifest:** `{{gbp_photo_manifest_path}}`
- **Fulfillment report:** `{{fulfillment_report_path}}`

## Identity and scope

- [ ] Restaurant name and full address match the Slack request.
- [ ] V2 location is under the correct customer account.
- [ ] Branding inheritance or location override is understood.
- [ ] Account-scoped branding is correct for every location on the account.

## Links

- [ ] Click every link in account settings, location settings, and the Link/Product editor.
- [ ] Click every visible item in the customer-facing link tree or tapcard preview.
- [ ] Compare the embedded post-fulfillment link-tree screenshot with the live link tree; identity, branding, labels, ordering, and visible destinations match.
- [ ] Every destination resolves without an error, login wall, security warning, or wrong-location redirect.
- [ ] Labels match destinations: Order opens ordering, Menu opens a menu, Careers opens jobs, and so on.
- [ ] Provider pages belong to the correct restaurant and location.
- [ ] Social profiles are brand-owned and belong to the correct restaurant or group.
- [ ] Mobile behavior is clean.
- [ ] Broken, misleading, duplicate, missing, or questionable links are recorded in Slack.

## Branding source comparison

- [ ] Review the generated proof embedded below.
- [ ] Review the embedded GBP photos, especially exterior signage, menus, and branded interiors.
- [ ] Compare the official website header logo, favicon, colors, and visual identity.
- [ ] Compare both captured website viewports; primary and secondary colors correspond to prominent visible semantic surfaces, not framework defaults or unused CSS.
- [ ] Confirm exact palette hex values match the computed-style manifest for the visible website elements being cited.
- [ ] Use social avatars only as supporting evidence.
- [ ] The proposal unmistakably represents this restaurant.
- [ ] The selected logo is the current primary mark.
- [ ] Colors come from the brand rather than incidental food, architecture, or photography.
- [ ] Choose one explicit outcome: **keep production**, **apply proposal**, or **revise proposal**.

## Logo and proof quality

- [ ] Logo source is at least 700 px on its longest side.
- [ ] Edges are crisp at 100% with no blur, jagged edges, halos, or AI reconstruction artifacts.
- [ ] The complete mark is present with no cropped letters, icon, border, or tagline.
- [ ] The complete mark fills its image canvas tightly; there is no removable transparent, white, or solid-color outer padding making it render small.
- [ ] Transparency is clean with no accidental rectangle.
- [ ] Counters and interior spaces remain correct.
- [ ] Thin lines and small text remain legible at badge size.
- [ ] Logo contrast against the card color is sufficient.
- [ ] Primary, secondary, and text colors match the real identity and remain readable.
- [ ] Logo, restaurant name, offer, and QR code do not overlap or crowd edges.
- [ ] Every `manual_review` flag was reviewed; accepted caveats and requested revisions are recorded.

## Badges

- [ ] Production active badge count increased by the requested quantity.
- [ ] Badges belong to the correct location and are unassigned unless requested otherwise.
- [ ] No duplicate batch was created by an automation retry.
- [ ] A badge/tapcard preview opens the correct location experience.

## Cam review and feedback

- [ ] Cam received the tap-card proof, live link-tree screenshot, GBP source photos, website, and branding case ID in Slack.
- [ ] Cam selected **approve**, **keep current production branding**, or **revise**.
- [ ] Revision feedback identifies the exact issue: logo, crop, resolution, color, contrast, composition, or identity mismatch.
- [ ] Cam's feedback is preserved verbatim against the branding case.
- [ ] Human approval is not inferred from an unattended production write.
- [ ] Any revision was re-reviewed and production readback matches the approved values.

## Review evidence

The automation appends the generated tap-card proof first, the validated live link-tree screenshot second, and then the exact Google-selected Places photos used as source evidence. Local paths above are operational references only.
