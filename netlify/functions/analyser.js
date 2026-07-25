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
- Le résumé doit rester COURT et concis : uniquement les points essentiels, pas plus de 150 mots, avec des titres brefs et des puces.
- Si un résumé existe déjà pour ce chapitre, complète-le intelligemment avec le nouveau contenu, sans répéter ce qui y est déjà, en gardant l'ensemble concis.
- Génère exactement 3 petits exercices (question + réponse courte) et un QCM d'exactement 3 questions (4 choix chacune, un seul bon), qui portent uniquement sur le contenu de cette photo.
- Reste bref partout : c'est très important que la réponse complète tienne dans la limite de longueur donnée.

Réponds UNIQUEMENT avec un objet JSON valide et complet, sans texte avant ni après, ni balises markdown, au format exact suivant :
{
  "resume": "le résumé en markdown (titres avec #, listes avec -)",
  "exercices": [ { "question": "...", "reponse": "..." } ],
  "qcm": [ { "question": "...", "choix": ["...", "...", "...", "..."], "bonneReponse": 0 } ]
}
"bonneReponse" est l'index (0 à 3) du bon choix dans le tableau "choix".
Termine toujours le JSON proprement (n'oublie pas les accolades et crochets de fermeture).`;

    const userText = existingSummary
      ? `Voici le résumé actuel du chapitre à compléter avec le contenu de cette nouvelle photo :\n\n${existingSummary}`
      : "Analyse cette photo de cours et génère un premier résumé, des exercices et un QCM pour ce chapitre.";

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
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

    if (data.stop_reason === "max_tokens") {
      console.error("Réponse IA tronquée (max_tokens atteint).");
    }

    const rawText = (data.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    // L'IA peut parfois entourer le JSON de ```json ... ``` malgré la consigne : on nettoie au cas où.
    let cleaned = rawText.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");

    // Filet de sécurité supplémentaire : si du texte traîne avant/après les accolades, on isole le JSON.
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error("Réponse IA non-JSON (probablement tronquée) :", rawText);
      return {
        statusCode: 502,
        body: JSON.stringify({
          error: "La réponse de l'IA était incomplète ou mal formée. Réessaie — ça arrive rarement deux fois de suite.",
        }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        summary: parsed.resume || "",
        exercices: Array.isArray(parsed.exercices) ? parsed.exercices : [],
        qcm: Array.isArray(parsed.qcm) ? parsed.qcm : [],
      }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: "Erreur interne du serveur." }) };
  }
};
