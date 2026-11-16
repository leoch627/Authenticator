<template>
  <div>
    <div>
      <div class="text warning" v-show="!isEncrypted || !defaultEncryption">
        {{ i18n.dropbox_risk }}
      </div>
      <div v-show="backupToken">
        <div style="margin: 10px 0px 0px 20px; overflow-wrap: break-word">
          {{ i18n.account }} - {{ email }}
        </div>
      </div>
      <a-select-input
        v-show="!!defaultEncryption && backupToken"
        :label="i18n.encrypted"
        v-model="isEncrypted"
      >
        <option value="true">{{ i18n.yes }}</option>
        <option value="false">{{ i18n.no }}</option>
      </a-select-input>
      <a-button v-show="backupToken" @click="backupLogout()">
        {{ i18n.log_out }}
      </a-button>
      <a-button v-show="!backupToken" @click="getBackupToken()">
        {{ i18n.sign_in }}
      </a-button>
      <a-button v-show="backupToken" @click="backupUpload()">
        {{ i18n.manual_dropbox }}
      </a-button>
    </div>
  </div>
</template>
<script lang="ts">
import Vue from "vue";
import { Dropbox, getBackupEncryption } from "../../models/backup";
import { UserSettings } from "../../models/settings";

const service = "dropbox";

export default Vue.extend({
  data: function () {
    return {
      email: this.i18n.loading,
    };
  },
  created() {
    UserSettings.updateItems();
  },
  computed: {
    defaultEncryption: function () {
      return this.$store.state.accounts.defaultEncryption;
    },
    isEncrypted: {
      get(): boolean {
        if (UserSettings.items[`${service}Encrypted`] === null) {
          this.$store.commit("backup/setEnc", { service, value: true });
          UserSettings.items[`${service}Encrypted`] = true;
          UserSettings.commitItems();
          return true;
        }
        return this.$store.state.backup.dropboxEncrypted;
      },
      set(newValue: string) {
        UserSettings.items.dropboxEncrypted = newValue === "true";
        UserSettings.commitItems();
        this.$store.commit("backup/setEnc", {
          service,
          value: newValue === "true",
        });
      },
    },
    backupToken: function () {
      return this.$store.state.backup.dropboxToken;
    },
  },
  watch: {
    backupToken: async function (signedIn: boolean) {
      if (signedIn) {
        this.email = await this.getUser();
      }
    },
  },
  methods: {
    getBackupToken() {
      chrome.runtime.sendMessage({ action: service });
    },
    async backupLogout() {
      await UserSettings.updateItems();
      const token = UserSettings.items.dropboxToken;
      if (token) {
        try {
          await fetch("https://api.dropboxapi.com/2/auth/token/revoke", {
            method: "POST",
            headers: { Authorization: "Bearer " + token },
          });
        } catch (error) {
          console.error(error);
        }
      }
      UserSettings.items.dropboxToken = undefined;
      UserSettings.items.dropboxRefreshToken = undefined;
      await UserSettings.commitItems();
      this.$store.commit("backup/setToken", { service, value: false });
      this.$store.commit("style/hideInfo");
    },
    async backupUpload() {
      let response = false;
      try {
        response = await new Dropbox().upload(
          getBackupEncryption(this.$store.state.accounts)
        );
      } catch (error) {
        console.error(error);
      }
      await UserSettings.updateItems();
      if (response === true) {
        this.$store.commit("notification/alert", this.i18n.updateSuccess);
      } else if (UserSettings.items.dropboxRevoked === true) {
        this.$store.commit(
          "notification/alert",
          chrome.i18n.getMessage("token_revoked", ["Dropbox"])
        );
        UserSettings.removeItem("dropboxRevoked");
        this.$store.commit("backup/setToken", { service, value: false });
      } else {
        this.$store.commit("notification/alert", this.i18n.updateFailure);
      }
    },
    async getUser() {
      const dbox = new Dropbox();
      return await dbox.getUser();
    },
  },
  mounted: async function () {
    if (this.backupToken) {
      this.email = await this.getUser();
    }
  },
});
</script>
