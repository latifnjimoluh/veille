import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import nodemailer from 'nodemailer';



dotenv.config(); // Charge les variables d'environnement depuis le fichier .env


const app = express();
const PORT = process.env.PORT || 3000;

// Récupérer les tokens et autres informations sensibles depuis le fichier .env
const notionToken = process.env.NOTION_TOKEN;
const notionVersion = process.env.NOTION_VERSION;
const geminiApiKey = process.env.GEMINI_API_KEY;
const emailUser = process.env.EMAIL_USER;
const emailPass = process.env.EMAIL_PASS;

// Configurer l'IA générative (Gemini)
const genAI = new GoogleGenerativeAI(geminiApiKey);

// Configurer Nodemailer
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: emailUser, // Votre email
        pass: emailPass  // Votre mot de passe ou token d'application
    }
});

app.use(express.json());

// Route pour lister les bases de données
app.get('/api/databases', async (req, res) => {
    try {
        const response = await axios.post(
            'https://api.notion.com/v1/search',
            {
                filter: {
                    property: 'object',
                    value: 'database'
                }
            },
            {
                headers: {
                    "Authorization": `Bearer ${notionToken}`,
                    "Notion-Version": notionVersion
                },
                timeout: 10000 // Augmenter le délai d'attente à 10 secondes
            }
        );

        if (!response.data || !response.data.results) {
            throw new Error("Réponse de Notion vide ou mal formée");
        }

        const databases = response.data.results.map(db => ({
            name: db.title[0]?.text?.content || 'Sans titre',
            id: db.id
        }));

        res.status(200).json({
            success: true,
            databases
        });
    } catch (error) {
        console.error("Erreur lors de la récupération des bases de données :", error.message || error);
        res.status(500).json({
            success: false,
            message: "Erreur lors de la récupération des bases de données",
            error: error.message || error
        });
    }
});

app.get('/api/databases-radar/:id', async (req, res) => {
    const databaseId = req.params.id;

    try {
        const response = await axios.post(
            `https://api.notion.com/v1/databases/${databaseId}/query`,
            {},
            {
                headers: {
                    "Authorization": `Bearer ${notionToken}`,
                    "Notion-Version": notionVersion
                }
            }
        );

        if (!response.data || !response.data.results) {
            throw new Error("Réponse de Notion vide ou mal formée");
        }

        // Transformation des résultats pour n'inclure que les champs nécessaires
        const formattedResults = response.data.results.map(page => {
            const properties = page.properties;

            return {
                Identifiant: properties["Identifiant"]?.unique_id?.number || null,
                Titre: properties["Titre"]?.title[0]?.plain_text || "N/A",
                Lien_Url: properties["Lien_Url"]?.url || "N/A",
                Statut: properties["Statut"]?.select?.name || "N/A",
                Résumé: properties["Résumé"]?.rich_text?.[0]?.plain_text || "N/A",
                Catégorie: properties["Catégorie"]?.select?.name || "N/A",
                Priorité: properties["Priorité"]?.formula?.string || "N/A",
                "Date de publication": properties["Date de publication"]?.date?.start || "N/A",
                Commentaires: properties["Commentaires"]?.rich_text?.[0]?.plain_text || "N/A",
                "Assigné à": properties["Assigné à"]?.rich_text?.[0]?.plain_text || "N/A"
            };
        });

        // Réponse formatée
        res.status(200).json({
            success: true,
            results: formattedResults
        });

    } catch (error) {
        console.error("Erreur lors de la récupération des données :", error.message || error);
        res.status(500).json({
            success: false,
            message: "Erreur lors de la récupération des données",
            error: error.message || error
        });
    }
});

const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

async function generateSummary(title, content, url) {
    try {
        // Si le résumé est vide, on n'ajoute que le titre et l'URL
        if (!content || content === 'Aucun résumé disponible') {
            content = `Voici un article intitulé "${title}". Vous pouvez consulter l'article complet ici : ${url}`;
        }

        // Construire un prompt plus complet incluant le titre, le résumé et le lien
        const prompt = `
            Voici un article à résumer. Le titre de l'article est : "${title}". 
            Veuillez produire un résumé concis et clair en mettant en évidence les points clés et les idées principales. 
            Ajoutez des émojis en fonction du contenu de l'article. 
            Pour plus de contexte, vous pouvez consulter l'article complet à l'adresse suivante : ${url}.
            
            Texte :
            ${content}
        `;

        const result = await model.generateContent(prompt);
        // Retourner le résumé généré avec le lien à la fin
        return `${result.response.text()} \n\nLire l'article complet ici : ${url}`;
    } catch (error) {
        console.error('Erreur lors de la génération du résumé avec Gemini :', error.message);
        return 'Résumé non disponible.';
    }
}

async function classifyCategory(title, content, url) {
    try {
        const prompt = `
            Voici une information issue d'une veille technologique.
            Le titre est : "${title}".
            Voici le contenu ou résumé de l'article : "${content}".
            Veuillez analyser cette information et déterminer sa catégorie parmi les options suivantes :
            - Cryptomonnaies
            - Trading
            - CPI (Indice des Prix à la Consommation)
            - Intelligence Artificielle
            - Cybersécurité
            - Autre
            Fournissez uniquement le nom de la catégorie comme réponse.
        `;

        const result = await model.generateContent(prompt);
        return result.response.text().trim(); // Retourner la catégorie identifiée
    } catch (error) {
        console.error("Erreur lors de la classification avec Gemini :", error.message);
        return "Autre"; // Par défaut, si une erreur survient
    }
}

app.post('/api/gemini-radar/:notionDatabaseId', async (req, res) => {
    const { notionDatabaseId } = req.params;
    const { recipientEmail } = req.body;

    if (!notionDatabaseId) {
        return res.status(400).json({ error: "L'ID de la base Notion est requis." });
    }

    if (!recipientEmail) {
        return res.status(400).json({ error: "L'email du destinataire est requis." });
    }

    try {
        const notionResponse = await axios.post(
            `https://api.notion.com/v1/databases/${notionDatabaseId}/query`,
            {},
            {
                headers: {
                    "Authorization": `Bearer ${notionToken}`,
                    "Notion-Version": notionVersion
                }
            }
        );

        const itemsWithDebutStatus = notionResponse.data.results.filter(item => {
            const status = item.properties?.['Statut']?.select?.name;
            return status === "Début";
        });

        if (itemsWithDebutStatus.length === 0) {
            return res.status(200).json({ message: "Aucune donnée avec le statut 'Début' trouvée." });
        }

        const veilleData = await Promise.all(itemsWithDebutStatus.map(async (item) => {
            const properties = item.properties;
            const titre = properties['Titre']?.title?.[0]?.text?.content || 'Sans titre';
            const resume = properties['Résumé']?.rich_text?.[0]?.text?.content || 'Aucun résumé disponible';
            const lienUrl = properties['Lien_Url']?.url || 'Pas d\'URL';

            const commentaire = await generateSummary(titre, resume, lienUrl);
            const categorie = await classifyCategory(titre, resume, lienUrl); // Identifier la catégorie

            // Mise à jour de la catégorie dans Notion
            await axios.patch(
                `https://api.notion.com/v1/pages/${item.id}`,
                {
                    properties: {
                        Catégorie: {
                            select: { name: categorie } // Mettre à jour la catégorie
                        },
                        Status: {
                            status: { name: "Terminé" } // Changer le statut
                        },
                        Commentaires: {
                            rich_text: [
                                {
                                    text: { content: commentaire }
                                }
                            ]
                        }
                    }
                },
                {
                    headers: {
                        "Authorization": `Bearer ${notionToken}`,
                        "Notion-Version": notionVersion
                    }
                }
            );

            return {
                id: item.id,
                Titre: titre,
                Lien_Url: lienUrl,
                Résumé: resume,
                Catégorie: categorie, // Catégorie mise à jour
                Commentaires: commentaire
            };
        }));

        // Configurer et envoyer l'email
        const mailOptions = {
            from: emailUser,
            to: recipientEmail,
            subject: 'Rapport de Veille Technologique',
            html: `
                <html>
                    <body>
                        <h2>Rapport de Veille Technologique</h2>
                        <ul>
                            ${veilleData.map(item => `
                                <li>
                                    <h3>${item.Titre}</h3>
                                    <p><strong>Catégorie :</strong> ${item.Catégorie}</p>
                                    <p><strong>Résumé :</strong> ${item.Résumé}</p>
                                    <p><strong>Source :</strong> <a href="${item.Lien_Url}" target="_blank">${item.Lien_Url}</a></p>
                                </li>
                            `).join('')}
                        </ul>
                    </body>
                </html>
            `
        };

        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                console.error("Erreur lors de l'envoi de l'email :", error);
                return res.status(500).json({ success: false, message: "Erreur lors de l'envoi de l'email.", error });
            }
            console.log("Email envoyé avec succès :", info.response);
            res.status(200).json({ success: true, message: "Rapport envoyé par email avec succès." });
        });

    } catch (error) {
        console.error("Erreur :", error.message || error);
        res.status(500).json({
            success: false,
            message: "Erreur lors de la récupération des données ou du traitement",
            error: error.message || error
        });
    }
});


// Lancement du serveur
app.listen(PORT, () => {
    console.log(`Serveur lancé sur http://localhost:${PORT}`);
});
