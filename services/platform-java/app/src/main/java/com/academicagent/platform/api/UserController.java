package com.academicagent.platform.api;

import java.util.Map;

import com.academicagent.platform.identity.service.UserService;
import com.academicagent.platform.security.AuthenticatedUser;
import com.academicagent.platform.security.CurrentUserProvider;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/users")
public class UserController {

    private final UserService userService;
    private final CurrentUserProvider currentUserProvider;

    public UserController(UserService userService, CurrentUserProvider currentUserProvider) {
        this.userService = userService;
        this.currentUserProvider = currentUserProvider;
    }

    @PatchMapping("/me")
    public Map<String, Object> updateMe(@RequestBody UpdateProfileRequest request) {
        AuthenticatedUser user = currentUserProvider.requireUser();
        if (request.displayName() == null || request.displayName().isBlank()) {
            return ApiMappers.userProfile(userService.getProfile(user.getUserId()));
        }
        return ApiMappers.userProfile(userService.updateDisplayName(user.getUserId(), request.displayName()));
    }

    public record UpdateProfileRequest(String displayName) {}
}
