---
name: boardroom-visual-review
description: Review actual desktop and mobile website screenshots for hierarchy, readability, spacing, alignment, contrast, responsiveness and task clarity. Requires an image-capable model and screenshot evidence; DOM checks alone are not visual review.
---
# Visual design review

Use `browser_check` on the delivered page to capture desktop and mobile images. Open both captured images using `screenshot_open`. If no image-capable model or attachment support is available, report that visual review is blocked. Do not describe pixels you did not receive or substitute DOM text for viewing the page.

Evaluate the page against its audience, intended task and design brief:

1. **Hierarchy and task clarity:** Is the primary purpose and next action apparent? Does the visual order match the content priorities? Identify competing calls to action or misleading emphasis.
2. **Readability and contrast:** Inspect type size, line length, density and background separation. Describe visible problems; measure actual colors or DOM styles before claiming a numerical WCAG contrast result. A screenshot cannot prove accessible semantics or keyboard behavior.
3. **Spacing and alignment:** Look for collisions, inconsistent gaps, awkward wrapping, misaligned controls, cramped sections and excessive empty space. Cite the affected region at each viewport.
4. **Responsive behavior:** Compare mobile and desktop. Check clipped content, stretched imagery, navigation, button sizing and content order. A successful overflow check does not prove the layout is usable.
5. **Consistency and credibility:** Check repeated controls, image quality, placeholder content, visual noise and coherence. Judge fidelity to the brief rather than imposing one preferred visual style.

Write a report with the exact screenshot paths, viewport sizes, model used, prioritized defects and concrete fixes. Each issue names its location, visible evidence, severity and acceptance check. Separate blocking usability defects from aesthetic preferences. Use pass/changes-requested/blocked, with no fabricated universal score.

Functional verification stays separate: use browser actions and assertions for the intended journey. Re-capture and inspect changed output before accepting a fix. Screenshots are tied to the delivered entry hash; stale images cannot certify changed files.

Reference criteria: https://www.w3.org/WAI/WCAG22/quickref/ and https://www.nngroup.com/articles/ten-usability-heuristics/. Visual review covers only observable criteria and is not a complete accessibility audit.
