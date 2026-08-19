// Fonction serveur Netlify — appelle l'API Claude pour analyser une photo de cours.
// La clé API reste ici, côté serveur, jamais visible dans le code du site.

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Méthode non autorisée" };
  }

  try {
    const {
      images,            // tableau de photos [{ base64, mediaType }, ...] — absent si finalize/renew
      finalize,          // true = pas de nouvelle photo, on consolide le résumé existant pour clore le chapitre
      renew,             // true = pas de nouvelle photo, on régénère juste un nouveau jeu d'exercices/QCM
      childAge,          // âge de l'enfant
      childStyles,       // tableau des préférences d'apprentissage (ids)
      subjectName,        // ex: "Orthographe"
      chapterTitle,       // ex: "Les accords du participe passé"
      existingSummary,    // résumé déjà existant du chapitre (pour l'enrichir, le finaliser, ou le renouveler)
    } = JSON.parse(event.body);

    const hasImages = Array.isArray(images) && images.length > 0;
    const textOnly = finalize || renew;

    if (!textOnly && !hasImages) {
      return { statusCode: 400, body: JSON.stringify({ error: "Aucune image reçue." }) };
    }
    if (textOnly && !existingSummary) {
      return { statusCode: 400, body: JSON.stringify({ error: "Aucun résumé disponible." }) };
    }

    const STYLE_LABELS = {
      mnemo: "des moyens mnémotechniques",
      points: "une présentation par points plutôt qu'en texte continu",
      images: "des schémas et des images pour illustrer",
      exemples: "beaucoup d'exemples concrets",
      acronymes: "des acronymes pour retenir les listes",
      histoires: "transformer les notions en petite histoire amusante ou absurde",
      chant: "une version chantée ou en rap pour les listes, conjugaisons ou formules",
    };
    const stylesText = (childStyles || [])
      .map((id) => STYLE_LABELS[id])
      .filter(Boolean)
      .join(", ");

    const jsonFormatInstructions = `Réponds UNIQUEMENT avec un objet JSON valide et complet, sans texte avant ni après, ni balises markdown, au format exact suivant :
{
  "correspond": true,
  "avertissement": "",
  "resume": "le résumé en markdown (titres avec #, listes avec -, mots-clés en **gras**)",
  "exercices": [ { "question": "...", "reponse": "..." } ],
  "qcm": [ { "question": "...", "choix": ["...", "...", "...", "..."], "bonneReponse": 0 } ]
}
"bonneReponse" est l'index (0 à 3) du bon choix dans le tableau "choix".
Termine toujours le JSON proprement (n'oublie pas les accolades et crochets de fermeture).`;

    let systemPrompt;
    let userContent;

    if (finalize) {
      // Mode "fin de chapitre" : pas de nouvelle photo, on consolide/nettoie le résumé existant.
      systemPrompt = `Tu es un professeur particulier bienveillant qui aide un enfant de ${childAge || "primaire/collège"} ans à réviser.
Voici le résumé accumulé au fil des séances pour le chapitre "${chapterTitle}" en ${subjectName}. Le chapitre est maintenant terminé.
${stylesText ? `Adapte ta réponse en utilisant si possible : ${stylesText}.` : ""}
Règles impératives :
- Réorganise et nettoie ce résumé pour en faire une version finale claire, bien structurée, sans doublons ni répétitions.
- Reste fidèle au contenu fourni, n'invente aucune information nouvelle.
- Le résumé final doit rester COURT et concis : pas plus de 200 mots, avec des titres brefs et des puces, des mots-clés en **gras**.
- Génère 10 exercices (question + réponse courte) et un QCM de 10 questions (4 choix chacune, un seul bon) qui couvrent l'ensemble du chapitre.
- Comme il n'y a pas de nouvelle photo à vérifier, mets toujours "correspond": true.
- Reste bref partout : c'est très important que la réponse complète tienne dans la limite de longueur donnée.

${jsonFormatInstructions}`;
      userContent = [
        { type: "text", text: `Voici le résumé à consolider pour clore ce chapitre :\n\n${existingSummary}` },
      ];
    } else if (renew) {
      // Mode "renouveler" : pas de nouvelle photo, le résumé ne change pas, seuls exercices/QCM sont régénérés.
      systemPrompt = `Tu es un professeur particulier bienveillant qui aide un enfant de ${childAge || "primaire/collège"} ans à réviser.
Voici le résumé du chapitre "${chapterTitle}" en ${subjectName}.
${stylesText ? `Adapte ta réponse en utilisant si possible : ${stylesText}.` : ""}
Règles impératives :
- Génère un TOUT NOUVEAU jeu de 10 exercices (question + réponse courte) et un QCM de 10 questions (4 choix chacune, un seul bon), différents de ce qui aurait pu être généré avant, mais toujours basés uniquement sur ce résumé.
- Reste fidèle au contenu du résumé, n'invente aucune information nouvelle.
- Renvoie aussi le champ "resume" avec exactement le même texte que celui fourni, sans le modifier.
- Comme il n'y a pas de nouvelle photo à vérifier, mets toujours "correspond": true.

${jsonFormatInstructions}`;
      userContent = [
        { type: "text", text: `Voici le résumé du chapitre :\n\n${existingSummary}` },
      ];
    } else {
      systemPrompt = `Tu es un professeur particulier bienveillant qui aide un enfant de ${childAge || "primaire/collège"} ans à réviser.
Voici ${images.length > 1 ? `${images.length} photos` : "la photo"} envoyée par l'enfant, censée être une page de cours sur le chapitre "${chapterTitle}" en ${subjectName}.
${images.length > 1 ? "Si plusieurs photos font partie du même chapitre, combine leur contenu en un seul résumé cohérent, sans le répéter plusieurs fois." : ""}
${stylesText ? `Adapte ta réponse en utilisant si possible : ${stylesText}.` : ""}

ÉTAPE 1 — Vérification obligatoire avant toute chose :
Vérifie si le contenu de la ou des photos correspond bien au sujet "${chapterTitle}" en ${subjectName}. Si la photo montre clairement une autre matière ou un autre sujet sans rapport, mets "correspond": false et explique brièvement dans "avertissement" ce qui ne va pas (ex : "Cette photo ressemble à un cours de français, pas de maths sur les fractions."). Dans ce cas, laisse "resume", "exercices" et "qcm" vides.
Si le contenu correspond bien (même approximativement, un chapitre peut couvrir plusieurs notions proches), mets "correspond": true et continue normalement.

ÉTAPE 2 — Si le contenu correspond, règles impératives pour le résumé :
- Reste strictement fidèle au contenu des photos, n'invente aucune information.
- Utilise un vocabulaire simple et adapté à l'âge de l'enfant.
- Le résumé doit rester COURT et concis : uniquement les points essentiels, pas plus de 200 mots, avec des titres brefs, des puces, et des mots-clés en **gras** pour le mettre en valeur.
- Si un résumé existe déjà pour ce chapitre, complète-le intelligemment avec le nouveau contenu, sans répéter ce qui y est déjà, en gardant l'ensemble concis.
- Génère exactement 5 petits exercices (question + réponse courte) et un QCM d'exactement 5 questions (4 choix chacune, un seul bon), qui portent uniquement sur le contenu de ces photos.
- Reste bref partout : c'est très important que la réponse complète tienne dans la limite de longueur donnée.

${jsonFormatInstructions}`;

      const userText = existingSummary
        ? `Voici le résumé actuel du chapitre à compléter avec le contenu de ${images.length > 1 ? "ces nouvelles photos" : "cette nouvelle photo"} :\n\n${existingSummary}`
        : `Analyse ${images.length > 1 ? "ces photos" : "cette photo"} de cours et génère un premier résumé, des exercices et un QCM pour ce chapitre.`;

      const imageBlocks = images.map((img) => ({
        type: "image",
        source: { type: "base64", media_type: img.mediaType || "image/jpeg", data: img.base64 },
      }));

      userContent = [...imageBlocks, { type: "text", text: userText }];
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 6000,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
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
        correspond: parsed.correspond !== false,
        avertissement: parsed.avertissement || "",
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
