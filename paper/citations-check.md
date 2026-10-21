# Citation check for docs/paper-trustworthy-shared-memory.md

One line per reference in the paper (19 references, 19 lines). For each, the URL was opened
and the title, authors, year and venue or arXiv id were compared with the paper's reference
list, and the paper's description of the work was compared with what the work says.

Checked 21 October 2026 by Ada home, which has web access (the drafting worker had none).
ACM Digital Library pages sit behind a bot check, so ACM metadata was read from the DOI
registry record (Crossref, `https://api.crossref.org/works/<DOI>`). 11 references needed a
correction to the entry or to how the body describes the work; those corrections are applied
in the paper, and each line below describes the reference as it now stands.

| # | Reference (as in the paper) | URL opened | matches |
| --- | --- | --- | --- |
| 1 | Park, O'Brien, Cai, Morris, Liang, Bernstein, "Generative Agents: Interactive Simulacra of Human Behavior", UIST 2023, doi:10.1145/3586183.3606763, arXiv:2304.03442 | https://arxiv.org/abs/2304.03442 ; Crossref 10.1145/3586183.3606763 | matches: yes |
| 2 | Wang, Xie, Jiang, Mandlekar, Xiao, Zhu, Fan, Anandkumar, "Voyager: An Open-Ended Embodied Agent with Large Language Models", TMLR 2024, arXiv:2305.16291 | https://arxiv.org/abs/2305.16291 ; https://openreview.net/forum?id=ehfRiF0R3a | matches: yes (venue updated to TMLR 2024) |
| 3 | Shinn, Cassano, Gopinath, Narasimhan, Yao, "Reflexion: Language Agents with Verbal Reinforcement Learning", NeurIPS 2023, arXiv:2303.11366 | https://proceedings.neurips.cc/paper_files/paper/2023/hash/1b44b878bb782e6954cd888628510e90-Abstract-Conference.html ; https://arxiv.org/abs/2303.11366 | matches: yes (author list now the NeurIPS one, 5 authors) |
| 4 | Packer, Wooders, Lin, Fang, Patil, Stoica, Gonzalez, "MemGPT: Towards LLMs as Operating Systems", 2023, arXiv:2310.08560 | https://arxiv.org/abs/2310.08560 | matches: yes |
| 5 | Greshake, Abdelnabi, Mishra, Endres, Holz, Fritz, "Not what you've signed up for: Compromising Real-World LLM-Integrated Applications with Indirect Prompt Injection", AISec 2023, doi:10.1145/3605764.3623985, arXiv:2302.12173 | https://arxiv.org/abs/2302.12173 ; Crossref 10.1145/3605764.3623985 | matches: yes |
| 6 | Chen, Xiang, Xiao, Song, Li, "AgentPoison: Red-teaming LLM Agents via Poisoning Memory or Knowledge Bases", NeurIPS 2024, arXiv:2407.12784 | https://arxiv.org/abs/2407.12784 ; https://proceedings.neurips.cc/paper_files/paper/2024/hash/eb113910e9c3f6242541c1652e30dfd6-Abstract-Conference.html | matches: yes (§1 now says the attacks are targeted) |
| 7 | Zou, Geng, Wang, Jia, "PoisonedRAG: Knowledge Corruption Attacks to Retrieval-Augmented Generation of Large Language Models", USENIX Security 2025, arXiv:2402.07867 | https://arxiv.org/abs/2402.07867 ; https://www.usenix.org/conference/usenixsecurity25/presentation/zou-poisonedrag | matches: yes (§1 now says model, not agent, and targeted) |
| 8 | Moreau, Missier (eds.), "PROV-DM: The PROV Data Model", W3C Recommendation, 30 April 2013 | https://www.w3.org/TR/prov-dm/ | matches: yes |
| 9 | OpenSSF SLSA project, "SLSA specification, version 1.0", 2023 (since retired; v1.2 current) | https://slsa.dev/spec/v1.0/ ; https://slsa.dev/spec/v1.0/levels ; https://slsa.dev/spec/v1.2/ | matches: yes (§6 now scoped to Build Level 2 and up) |
| 10 | Torres-Arias, Afzali, Kuppusamy, Curtmola, Cappos, "in-toto: Providing farm-to-table guarantees for bits and bytes", USENIX Security 2019 | https://www.usenix.org/conference/usenixsecurity19/presentation/torres-arias | matches: yes |
| 11 | Laurie, Langley, Kasper, "Certificate Transparency", RFC 6962 (Experimental), IETF, June 2013, obsoleted by RFC 9162 | https://www.rfc-editor.org/info/rfc6962/ ; https://www.rfc-editor.org/info/rfc9162 | matches: yes (§6 no longer says "every certificate") |
| 12 | Rundgren, Jordan, Erdtman, "JSON Canonicalization Scheme (JCS)", RFC 8785 (Informational, Independent Submission), June 2020 | https://www.rfc-editor.org/info/rfc8785/ | matches: yes (no longer labeled IETF) |
| 13 | Adler, de Alfaro, "A Content-Driven Reputation System for the Wikipedia", WWW 2007, doi:10.1145/1242572.1242608 | https://doi.org/10.1145/1242572.1242608 ; Crossref 10.1145/1242572.1242608 ; https://archives.iw3c2.org/www2007/papers/paper692.pdf | matches: yes |
| 14 | Halfaker, Geiger, "ORES: Lowering Barriers with Participatory Machine Learning in Wikipedia", PACM HCI 4 (CSCW2), 2020, doi:10.1145/3415219, arXiv:1909.05189 | https://arxiv.org/abs/1909.05189 ; Crossref 10.1145/3415219 | matches: yes |
| 15 | Zheng, Chiang, Sheng, Zhuang, Wu, Zhuang, Lin, Li, Li, Xing, Zhang, Gonzalez, Stoica, "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena", NeurIPS 2023 Datasets and Benchmarks, arXiv:2306.05685 | https://arxiv.org/abs/2306.05685 ; https://arxiv.org/pdf/2306.05685 ; https://proceedings.neurips.cc/paper_files/paper/2023/hash/91f18a1287b398d378ef22505bf41832-Abstract-Datasets_and_Benchmarks.html | matches: yes (no longer cited for self-preference; §5 and §6 now say position bias appeared in judges from both providers) |
| 16 | Panickssery, Bowman, Feng, "LLM Evaluators Recognize and Favor Their Own Generations", NeurIPS 2024, arXiv:2404.13076 | https://arxiv.org/abs/2404.13076 ; https://proceedings.neurips.cc/paper_files/paper/2024/hash/7f1f0218e45f5414c79c0679633e47bc-Abstract-Conference.html | matches: yes (§5 no longer claims the design avoids self-review) |
| 17 | Project Noosphere, "The Noosphere Charter", version 2, approved 30 September 2026 | https://projectnoosphere.org/charter | matches: yes |
| 18 | Model Context Protocol, "Specification", version 2026-07-28 | https://modelcontextprotocol.io/specification/2026-07-28 | matches: yes (pinned to the version) |
| 19 | Trust4RSI-Agent: AAAI 2027 Workshop on Trustworthy Evolution of AI Agents: An Agent Operating System Perspective, workshop website, accessed 21 October 2026 | https://trust4rsi-agent.github.io/AAAI2027/ | matches: yes (quote now complete; wording "mature computing systems" / "the model"; cited as the About section, not the call) |
