import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import nodemailer from 'nodemailer';
import moment from 'moment';



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


// Route pour récupérer et envoyer le rapport par email
app.post('/api/gemini-techno/:notionDatabaseId', async (req, res) => {
    const { notionDatabaseId } = req.params;
    const { recipientEmail } = req.body;

    if (!notionDatabaseId) {
        return res.status(400).json({ error: "L'ID de la base Notion est requis." });
    }

    if (!recipientEmail) {
        return res.status(400).json({ error: "L'email du destinataire est requis." });
    }

    try {
        // Étape 1 : Récupérer les données depuis Notion
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

        if (!notionResponse.data || !notionResponse.data.results) {
            throw new Error("Réponse de Notion vide ou mal formée.");
        }

        const itemsWithDebutStatus = notionResponse.data.results.filter(item => {
            const status = item.properties?.['Statusy']?.select?.name;
            return status === "Pas commencé";
        });

        if (itemsWithDebutStatus.length === 0) {
            return res.status(200).json({ message: "Aucune donnée avec le statut 'Pas commencé' trouvée." });
        }

        // Étape 2 : Traitement des données avec Gemini
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const veilleData = await Promise.all(itemsWithDebutStatus.map(async (item) => {
            const properties = item.properties;

            const name = properties['Nom_Veille']?.title?.[0]?.text?.content || 'Sans titre';
            const url = properties['Source URL']?.url || 'Pas d\'URL';
            const publicationDate = properties['Publication Date']?.date?.start || 'Pas de date';
            const description = properties['Description']?.rich_text?.[0]?.text?.content || 'Pas de description';

            // Générer un résumé pour l'article
            const commentaire = await generateSummary(name, description, url);

            // Classifier l'article en catégorie
            const promptClassification = `
                Voici un article :
                Titre : "${name}"
                Description : "${description}"
                Veuillez classer cet article dans l'une des catégories suivantes :
                - Cryptomonnaies
                - Trading
                - CPI
                - Intelligence Artificielle
                - Cybersécurité
                - Autre
                Répondez uniquement par le nom de la catégorie.
            `;
            const classificationResponse = await model.generateContent(promptClassification);
            const category = classificationResponse.response.text().trim();

            // Mise à jour dans Notion
            await axios.patch(
                `https://api.notion.com/v1/pages/${item.id}`,
                {
                    properties: {
                        Catégorie: {
                            select: { name: category }
                        },
                        Status: {
                            status: { name: "Terminé" }
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
                name,
                url,
                publicationDate,
                description,
                category,
                commentaire
            };
        }));

        // Étape 3 : Générer un rapport détaillé
        const veilleString = JSON.stringify(veilleData);
        const promptRapport = `
            Analyse ces données issues d'une veille technologique :
            ${veilleString}
            Trie-les par pertinence, classe-les par catégories (Actualités, Outils, Bonnes Pratiques, etc.), 
            et fournis un rapport synthétique prêt à être envoyé. 
            Assure-toi que chaque catégorie inclut des explications pertinentes et un ordre clair.
        `;
        const rapportResponse = await model.generateContent(promptRapport);
        const rapportAI = rapportResponse.response.text();

        // Étape 4 : Configurer et envoyer l'email avec le contenu généré
        const mailOptions = {
            from: emailUser,
            to: recipientEmail,
            subject: 'Rapport de Veille Technologique',
            html: `
                <html>
                    <body>
                        <h2 style="color:#2C3E50;">Rapport de Veille Technologique</h2>
                        <p><strong>Bonjour,</strong></p>
                        <p>Voici le rapport de veille technologique généré pour vous :</p>
                        <ul>
                            ${veilleData.map(item => `
                                <li>
                                    <h3 style="color:#2980B9;"><strong>${item.name}</strong></h3>
                                    <p><strong>Catégorie :</strong> ${item.category}</p>
                                    <p><strong>Publication Date :</strong> ${item.publicationDate}</p>
                                    <p><strong>Description :</strong> ${item.description}</p>
                                    <p><strong>Source :</strong> <a href="${item.url}" target="_blank">${item.url}</a></p>
                                    <p><strong>Résumé :</strong> ${item.commentaire}</p>
                                </li>
                            `).join('')}
                        </ul>
                        <h3>Résumé global :</h3>
                        <p>${rapportAI}</p>
                        <p><strong>Bonne lecture et à bientôt !</strong></p>
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
            res.status(200).json({ success: true, message: "Rapport envoyé par email avec succès.", suggestions: rapportAI });
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


app.post('/api/gemini-tech/:notionDatabaseId', async (req, res) => {
    const { notionDatabaseId } = req.params;
    const { recipientEmail } = req.body;

    if (!notionDatabaseId || !recipientEmail) {
        return res.status(400).json({ error: "L'ID de la base Notion et l'email du destinataire sont requis." });
    }

    try {
        // Étape 1 : Récupérer les données depuis Notion
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

        if (!notionResponse.data || !notionResponse.data.results) {
            throw new Error("Réponse de Notion vide ou mal formée.");
        }

        // Filtrage des informations importantes et des statuts "Pas commencé"
        const veilleData = notionResponse.data.results
            .map((page) => {
                const props = page.properties;
                const publicationDate = props["Publication Date"]?.date?.start;
                const formattedDate = publicationDate ? moment(publicationDate).format('D MMMM YYYY [à] HH:mm') : "Non défini";
                
                return {
                    id: page.id,
                    title: props.titre?.rich_text[0]?.text?.content || "Titre non défini",
                    website: props.Website?.url || "Non défini",
                    status: props.Status?.status?.name || "Non défini",
                    publicationDate: formattedDate,
                    description: props.Description?.rich_text?.map(text => text.plain_text).join(" ") || "Non défini",
                    createdBy: props["Créée par"]?.created_by?.name || "Non défini",
                    url: page.url
                };
            })
            .filter(item => item.status === "Pas commencé"); // Filtrer uniquement les pages avec le statut "Pas commencé"

        if (veilleData.length === 0) {
            return res.status(200).json({ success: true, message: "Aucune donnée avec le statut 'Pas commencé'." });
        }

        // Étape 2 : Envoyer les données à Gemini pour analyse
        const veilleString = JSON.stringify(veilleData);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `
        Analyse les données suivantes issues d'une base de données Notion. 
        Identifie et trie uniquement les informations pertinentes pour une veille technologique efficace. 
        Organise les informations par ordre d'importance et classe-les en catégories (Actualités, Outils, Bonnes Pratiques, etc.). 
        Voici les données à analyser :\n\n${veilleString}
        `;
        const result = await model.generateContent(prompt);
        const responseAI = await result.response;
        const generatedText = await responseAI.text();

        // Étape 3 : Configurer et envoyer l'email
        const mailOptions = {
            from: emailUser,
            to: recipientEmail,
            subject: 'Rapport de Veille Technologique',
            html: `
                <html>
                    <body>
                        <h2 style="color:#2C3E50;">Rapport de Veille Technologique</h2>
                        <p><strong>Bonjour,</strong></p>
                        <p>Voici le rapport de veille technologique généré pour vous :</p>
                        <ul>
                            ${veilleData.map(item => `
                                <li>
                                    <h3 style="color:#2980B9;"><strong>${item.title}</strong></h3>
                                    <p><strong>Statut :</strong> ${item.status}</p>
                                    <p><strong>Date de publication :</strong> ${item.publicationDate}</p>
                                    <p><strong>Description :</strong> ${item.description}</p>
                                    <p><strong>Source :</strong> <a href="${item.website}" target="_blank">${item.website}</a></p>
                                    <p><strong>Créé par :</strong> ${item.createdBy}</p>
                                    <p><strong>URL Notion :</strong> <a href="${item.url}" target="_blank">${item.url}</a></p>
                                </li>
                            `).join('')}
                        </ul>
                        <h3>Résumé et analyse de Gemini :</h3>
                        <p>${generatedText}</p>
                        <p><strong>Bonne lecture et à bientôt !</strong></p>
                    </body>
                </html>
            `
        };

        transporter.sendMail(mailOptions, async (error, info) => {
            if (error) {
                console.error("Erreur lors de l'envoi de l'email :", error);
                return res.status(500).json({ success: false, message: "Erreur lors de l'envoi de l'email.", error });
            }
            console.log("Email envoyé avec succès :", info.response);

            // Étape 4 : Mettre à jour le statut des pages dans Notion
            for (const item of veilleData) {
                try {
                    await axios.patch(
                        `https://api.notion.com/v1/pages/${item.id}`,
                        {
                            properties: {
                                Status: {
                                    status: {
                                        name: "Terminé" // Nouveau statut
                                    }
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
                    console.log(`Statut mis à jour pour la page : ${item.id}`);
                } catch (updateError) {
                    console.error(`Erreur lors de la mise à jour du statut pour la page ${item.id} :`, updateError.message || updateError);
                }
            }

            res.status(200).json({ success: true, message: "Rapport envoyé par email et statut mis à jour avec succès.", suggestions: generatedText });
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

 // Route pour récupérer les données de la veille
 app.get('/api/databases-techno/:id', async (req, res) => {
    const databaseId = req.params.id;

    try {
        console.log(`Tentative de récupération des données pour la base : ${databaseId}`);

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

        const results = response.data.results.map((item) => {
            const properties = item.properties;
            return {
                name: properties['Nom_Veille']?.title?.[0]?.text?.content || 'Sans titre',
                url: properties['Source URL']?.url || 'Pas d\'URL',
                publicationDate: properties['Publication Date']?.date?.start || 'Pas de date',
                description: properties['Description']?.rich_text?.[0]?.text?.content || 'Pas de description'
            };
        });

        res.status(200).json({
            success: true,
            veilleData: results
        });
    } catch (error) {
        console.error("Erreur lors de la récupération des données :", error.message || error);
        res.status(500).json({
            success: false,
            message: "Erreur lors de la récupération des données de veille",
            error: error.message || error
        });
    }
});

app.get('/api/databases-tech/:id', async (req, res) => {
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

        // Filtrer les informations importantes
        const filteredResults = response.data.results.map(page => {
            const props = page.properties;
            return {
                id: page.id,
                title: props.titre?.rich_text[0]?.text?.content || "Titre non défini",
                website: props.Website?.url || "Non défini",
                status: props.Status?.status?.name || "Non défini",
                publicationDate: props["Publication Date"]?.date?.start || "Non défini",
                description: props.Description?.rich_text?.map(text => text.plain_text).join(" ") || "Non défini",
                createdBy: props["Créée par"]?.created_by?.name || "Non défini",
                url: page.url
            };
        });

        res.status(200).json({
            success: true,
            results: filteredResults
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
