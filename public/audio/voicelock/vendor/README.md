# Terceiro: DeepFilterNet3 Noise Filter

`deepfilter-core.js` foi copiado sem modificações do pacote
`deepfilternet3-noise-filter@1.3.0`, projeto
`mezonai/mezon-noise-suppression`.

Somente o núcleo independente de LiveKit foi mantido para não adicionar o SDK
LiveKit ao DSpeak. As licenças originais estão em `LICENSE-MIT` e
`LICENSE-APACHE`.

O modelo carregado por esse núcleo é o Hush (`weya-ai/hush`) fixado por commit
e verificado por SHA-256 em `scripts/prepare-voicelock-postfilter.js`.
