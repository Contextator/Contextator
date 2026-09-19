# Contributor Licence Agreement — Contextator

## Why this exists

Contextator is free software under the [GNU Affero General Public License, version 3 or later](LICENSE),
and that is not going to change. Alongside it, the copyright holder offers a **commercial licence** to
organisations whose policies forbid AGPL software even for unmodified internal use. Both offers are real,
and the second one only works while the copyright is held in full.

The moment a contribution is merged without a licence grant, the file it touches can no longer be
relicensed by anyone acting alone — the contributor holds copyright in their part of it, and a commercial
licence over that file would need their permission every time. Reverting the commit does not undo this.

So this agreement asks you for a licence broad enough to keep both offers open. It does **not** ask you to
give up your copyright: you keep it, you keep the right to use your own contribution anywhere else, and
your contribution stays available to everyone under the AGPL regardless of what any commercial licence
says.

## Definitions

- **"You"** means the individual or the legal entity granting these rights.
- **"The Holder"** means Muhammet Şafak (Tunedness), the copyright holder of Contextator.
- **"Contribution"** means any work of authorship you intentionally submit to the project — code, tests,
  documentation, configuration — through a pull request, a patch, an issue attachment or any other
  channel, excluding anything you clearly mark as "not a Contribution".

---

## 1. Individual contributors

You are signing for yourself, and the work is yours.

**1.1 Copyright licence.** You grant the Holder a perpetual, worldwide, non-exclusive, irrevocable,
royalty-free licence to reproduce, prepare derivative works of, publicly display, publicly perform,
sublicense and distribute your Contribution and derivative works of it, **under any licence terms,
including proprietary ones**. This is what allows your Contribution to ship under the AGPL and, where the
Holder grants one, under a commercial licence.

**1.2 Patent grant.** You grant the Holder a perpetual, worldwide, non-exclusive, irrevocable (except as
stated below), royalty-free patent licence to make, have made, use, offer to sell, sell, import and
otherwise transfer your Contribution, covering only those patent claims you own or control that are
necessarily infringed by your Contribution alone or by its combination with the project. If you institute
patent litigation alleging that the project or a Contribution in it infringes a patent, the patent
licences granted to you under this agreement terminate as of the date that litigation is filed.

**1.3 What you are confirming.** That the Contribution is your original work; that you are legally
entitled to grant the licences above; that if your employer has rights in work you produce, you have
their permission or they have waived those rights; and that, to your knowledge, the Contribution does not
knowingly infringe anyone else's copyright, patent, trademark or trade secret.

**1.4 Third-party material.** If your Contribution includes work that is not yours — a snippet from
another project, a vendored file, a generated artefact carrying someone else's terms — say so in the pull
request and name its licence and origin. Such material is not covered by the grants above, and whether it
can be included is a decision, not a formality.

**1.5 No obligation and no warranty.** Nothing here obliges the Holder to use, merge or keep your
Contribution. Except for the confirmations in 1.3, you provide it "as is", without warranties of any kind.

**1.6 What you keep.** All of it. You retain ownership of your Contribution and every right to use,
licence and exploit it however you wish, including in other projects and on other terms.

---

## 2. Entity contributors

Use this section when the work is done by employees or contractors of a company, or otherwise belongs to
an organisation rather than to an individual.

**2.1 The grants.** The entity grants the Holder the same copyright licence (1.1) and patent licence (1.2)
as an individual does, on the same terms, for every Contribution submitted by anyone acting on its behalf.

**2.2 Authority.** The person accepting on the entity's behalf confirms that they are authorised to bind
it, and that the entity owns or controls the rights being granted.

**2.3 Who is covered.** The entity is responsible for the Contributions of its employees and contractors
made in the course of their work for it. It may name the individuals it covers, and update that list, by
saying so in writing to the Holder.

**2.4 Everything else.** Sections 1.3 to 1.6 apply to the entity as they apply to an individual, with
"you" read as the entity.

---

## 3. How the grant is recorded

You sign by leaving this sentence, on its own, as a comment on your pull request:

> I have read the CLA Document and I hereby sign the CLA

A GitHub Action reads the comment, appends you to `signatures/v1/cla.json` in
`Contextator/cla-signatures`, and turns the **Licence grant** check on your pull request green. The
signature is recorded against the account that left the comment, and it counts only for the accounts that
actually authored the commits — nobody can sign on somebody else's behalf. You sign once; later pull
requests are already covered.

If the check stays red after you have signed, comment `recheck` and the Action will look again. It reads
one comment at a time, so put the sentence in a comment of its own rather than inside a longer reply.

The record lives in a repository this organisation owns rather than in a service somebody else runs,
because the argument in *Why this exists* rests on it. Nobody is exempt, maintainers included.

---

*Questions about this document, or about a commercial licence, go to the Holder — see
[tunedness.com](https://tunedness.com). This is not legal advice, and you are free to take your own.*
