// Fonction serveur Netlify — appelle l'API Claude pour analyser une photo de cours.
// La clé API reste ici, côté serveur, jamais visible dans le code du site.

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Méthode non autorisée" };
  }

  try {
    const {
      imageBase64,      // photo du cours, en base64 (sans le préfixe data:...)
      mediaType,        // ex: "image/jpeg"
      childAge,         // âge de l'enfant
      childStyles,      // tableau des préférences d'apprentissage (ids)
      subjectName,       // ex: "Orthographe"
      chapterTitle,      // ex: "Les accords du participe passé"
      existingSummary,   // résumé déjà existant du chapitre (pour l'enrichir), ou vide
    } = JSON.parse(event.body);

    if (!imageBase64) {
      return { statusCode: 400, body: JSON.stringify({ error: "Aucune image reçue." }) };
    }

    const STYLE_LABELS = {
      mnemo: "des moyens mnémotechniques",
      points: "une présentation par points plutôt qu'en texte continu",
      images: "des schémas et des images pour illustrer",
      exemples: "beaucoup d'exemples concrets",
    };
    const stylesText = (childStyles || [])
      .map((id) => STYLE_LABELS[id])
      .filter(Boolean)
      .join(", ");

    const systemPrompt = `Tu es un professeur particulier bienveillant qui aide un enfant de ${childAge || "primaire/collège"} ans à réviser.
Voici la photo d'une page de cours sur le chapitre "${chapterTitle}" en ${subjectName}.
${stylesText ? `Adapte ta réponse en utilisant si possible : ${stylesText}.` : ""}
Règles impératives :
- Reste strictement fidèle au contenu de la photo, n'invente aucune information.
- Utilise un vocabulaire simple et adapté à l'âge de l'enfant.
- Structure ta réponse avec des titres courts et des puces, pas de longs paragraphes.
- Si un résumé existe déjà pour ce chapitre, complète-le intelligemment avec le nouveau contenu, sans répéter ce qui y est déjà.`;

    const userText = existingSummary
      ? `Voici le résumé actuel du chapitre à compléter avec le contenu de cette nouvelle photo :\n\n${existingSummary}`
      : "Analyse cette photo de cours et génère un premier résumé du chapitre.";

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1200,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: imageBase64 } },
              { type: "text", text: userText },
            ],
          },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Erreur API Anthropic:", data);
      return { statusCode: 502, body: JSON.stringify({ error: "L'IA n'a pas pu répondre. Réessaie dans un instant." }) };
    }

    const summary = (data.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    return {
      statusCode: 200,
      body: JSON.stringify({ summary }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: "Erreur interne du serveur." }) };
  }
};

