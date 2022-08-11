import { IHttp, IModify, IPersistence, IRead } from '@rocket.chat/apps-engine/definition/accessors';
import { IRoom } from '@rocket.chat/apps-engine/definition/rooms';
import { UIKitViewSubmitInteractionContext } from '@rocket.chat/apps-engine/definition/uikit';
import { ModalsEnum } from '../enum/Modals';
import { sendMessage, sendNotification } from '../lib/message';
import { getInteractionRoomData } from '../persistance/roomInteraction';
import { Subscription } from '../persistance/subscriptions';
import { GithubApp } from '../GithubApp';
import { getWebhookUrl } from '../helpers/getWebhookURL';
import { addSubscribedEvents, createSubscription, updateSubscription, createNewIssue, getIssueTemplates } from '../helpers/githubSDK';
import { getAccessTokenForUser } from '../persistance/auth';
import { subsciptionsModal } from '../modals/subscriptionsModal';
import { NewIssueModal } from '../modals/newIssueModal';
import { issueTemplateSelectionModal } from '../modals/issueTemplateSelectionModal';

export class ExecuteViewSubmitHandler {
    constructor(
        private readonly app: GithubApp,
        private readonly read: IRead,
        private readonly http: IHttp,
        private readonly modify: IModify,
        private readonly persistence: IPersistence,
    ) { }

    public async run(context: UIKitViewSubmitInteractionContext) {
        const { user, view } = context.getInteractionData();

        try {
            switch (view.id) {
                case ModalsEnum.ADD_SUBSCRIPTION_VIEW:
                    if (user.id) {
                        const { roomId } = await getInteractionRoomData(this.read.getPersistenceReader(), user.id);
                        if (roomId) {
                            let room = await this.read.getRoomReader().getById(roomId) as IRoom;
                            const repository = view.state?.[ModalsEnum.REPO_NAME_INPUT]?.[ModalsEnum.REPO_NAME_INPUT_ACTION];
                            const events = view.state?.[ModalsEnum.ADD_SUBSCRIPTION_EVENT_INPUT]?.[ModalsEnum.ADD_SUBSCRIPTION_EVENT_OPTIONS];

                            if (typeof (repository) == undefined || typeof (events) == undefined) {

                                await sendNotification(this.read, this.modify, user, room, "Invalid Input !");
                            } else {
                                let accessToken = await getAccessTokenForUser(this.read, user, this.app.oauth2Config);
                                if (!accessToken) {

                                    await sendNotification(this.read, this.modify, user, room, "Login To Github !");
                                } else {
                                    //if we have a webhook for the repo and our room requires the same event,we just make our entries to the apps storage instead of making a new hook
                                    //if we have a hook but we dont have all the events, we send in a patch request,

                                    let url = await getWebhookUrl(this.app);

                                    let subsciptionStorage = new Subscription(this.persistence, this.read.getPersistenceReader());
                                    let subscribedEvents = new Map<string, boolean>;
                                    let hookId = "";


                                    let subscriptions = await subsciptionStorage.getSubscriptionsByRepo(repository, user.id);
                                    if (subscriptions && subscriptions.length) {
                                        for (let subscription of subscriptions) {
                                            subscribedEvents.set(subscription.event, true);
                                            if (hookId == "") {
                                                hookId = subscription.webhookId;
                                            }
                                        }
                                    }
                                    let additionalEvents = 0;
                                    for (let event of events) {
                                        if (!subscribedEvents.has(event)) {
                                            additionalEvents++;
                                            subscribedEvents.set(event, true);
                                        }
                                    }
                                    let response: any;
                                    //if hook is null we create a new hook, else we add more events to the new hook
                                    if (hookId == "") {
                                        response = await createSubscription(this.http, repository, url, accessToken.token, events);
                                    } else {
                                        //if hook is already present, we just need to send a patch request to add new events to existing hook
                                        let newEvents: Array<string> = [];
                                        for (let [event, present] of subscribedEvents) {
                                            newEvents.push(event);
                                        }
                                        if (additionalEvents && newEvents.length) {
                                            response = await updateSubscription(this.http, repository, accessToken.token, hookId, newEvents);
                                        }
                                    }
                                    let createdEntry = false;
                                    //subscribe rooms to hook events
                                    for (let event of events) {
                                        createdEntry = await subsciptionStorage.createSubscription(repository, event, response?.id, room, user);
                                    }
                                    if (!createdEntry) {
                                        throw new Error("Error creating new subscription entry");
                                    }
                                    await sendNotification(this.read, this.modify, user, room, `Subscibed to ${repository} ✔️`);
                                }

                            }
                            const modal = await subsciptionsModal({ modify: this.modify, read: this.read, persistence: this.persistence, http: this.http, uikitcontext: context });
                            await this.modify.getUiController().updateModalView(modal, { triggerId: context.getInteractionData().triggerId }, context.getInteractionData().user);
                            return context.getInteractionResponder().successResponse();
                        }
                    }
                    break;
                case ModalsEnum.NEW_ISSUE_VIEW: {
                    const { roomId } = await getInteractionRoomData(this.read.getPersistenceReader(), user.id);
                    if (roomId) {
                        let room = await this.read.getRoomReader().getById(roomId) as IRoom;
                        let repository = view.state?.[ModalsEnum.REPO_NAME_INPUT]?.[ModalsEnum.REPO_NAME_INPUT_ACTION] as string;
                        let title = view.state?.[ModalsEnum.ISSUE_TITLE_INPUT]?.[ModalsEnum.ISSUE_TITLE_ACTION] as string;
                        let issueBody =  view.state?.[ModalsEnum.ISSUE_BODY_INPUT]?.[ModalsEnum.ISSUE_BODY_INPUT_ACTION];
                        let issueLabels = view.state?.[ModalsEnum.ISSUE_LABELS_INPUT]?.[ModalsEnum.ISSUE_LABELS_INPUT_ACTION] as string;
                        issueLabels = issueLabels.trim();
                        let issueAssignees = view.state?.[ModalsEnum.ISSUE_ASSIGNEES_INPUT]?.[ModalsEnum.ISSUE_ASSIGNEES_INPUT_ACTION] as string;
                        repository = repository.trim();
                        title = title.trim();
                        issueAssignees = issueAssignees.trim();
                        let issueLabelsArray:Array<string> = issueLabels.split(" ");
                        let issueAssigneesArray:Array<string> = issueAssignees.split(" ");
                        if(repository && repository?.length && title && title?.length){
                            let accessToken = await getAccessTokenForUser(this.read, user, this.app.oauth2Config);
                            if (!accessToken) {
                                await sendNotification(this.read, this.modify, user, room, "Login To Github !");
                            } else {
                                let reponse = await createNewIssue(this.http,repository,title,issueBody,issueLabelsArray,issueAssigneesArray,accessToken?.token)
                                if(reponse && reponse?.id){
                                    await sendNotification(this.read,this.modify,user,room,`Created New Issue | [#${reponse.number} ](${reponse.html_url})  *[${reponse.title}](${reponse.html_url})*`)
                                }else{
                                    await sendNotification(this.read,this.modify,user,room,`Invalid Issue !`);
                                }
                            }
                        }else{
                            await sendNotification(this.read,this.modify,user,room,`Invalid Issue !`);
                        }
                    } 
                    break;
                }
                case ModalsEnum.NEW_ISSUE_STARTER_VIEW:{
                    const { roomId } = await getInteractionRoomData(this.read.getPersistenceReader(), user.id);
    
                    if (roomId) {
                        let room = await this.read.getRoomReader().getById(roomId) as IRoom;
                        let repository = view.state?.[ModalsEnum.REPO_NAME_INPUT]?.[ModalsEnum.REPO_NAME_INPUT_ACTION] as string;
                        let accessToken = await getAccessTokenForUser(this.read, user, this.app.oauth2Config);
                        if (!accessToken) {
                            await sendNotification(this.read, this.modify, user, room, `Login To Github ! -> /github login`);
                        }else{
                            
                            repository=repository?.trim();
                            let response = await getIssueTemplates(this.http,repository,accessToken.token);
                            if((!response.template_not_found) && response?.templates?.length){
                                const issueTemplateSelection = await issueTemplateSelectionModal({ data: response, modify: this.modify, read: this.read, persistence: this.persistence, http: this.http, uikitcontext: context });
                                return context
                                .getInteractionResponder()
                                .openModalViewResponse(issueTemplateSelection);
                            }else{
                                let data = {
                                    repository: repository
                                }
                                const createNewIssue = await NewIssueModal({ data: data, modify: this.modify, read: this.read, persistence: this.persistence, http: this.http, uikitcontext: context });
                                return context
                                .getInteractionResponder()
                                .openModalViewResponse(createNewIssue);
                            }
                        }
                    } 
                    break;
                }
                default:
                    break;
            }

        } catch (error) {
            console.log('error : ', error);
        }

        return {
            success: true,
        };
    }
}